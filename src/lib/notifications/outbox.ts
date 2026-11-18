import { randomUUID } from "node:crypto";

import {
  type DbExecutor,
  type DbPool,
  queryMany,
  queryOne,
  withTransaction,
} from "../db/connection.ts";
import {
  STANDALONE,
  type ChannelContext,
  type ChannelFailure,
  type MessagePlacement,
  type NotificationChannel,
  type SendOptions,
  type SendResult,
  type ThreadRef,
} from "./channel.ts";
import {
  BURST_HOLD_SECONDS,
  BURST_KINDS,
  IN_PLACE_KINDS,
  notificationKindFor,
  NOTIFICATION_EVENTS,
  type NotificationEventKind,
} from "./events.ts";
import {
  buildNotificationMessage,
  readNotificationPayload,
  type NotificationBrand,
  type NotificationEnvelope,
  type NotificationPayload,
} from "./message.ts";
import { listPreferencesForUsers } from "./preferences.ts";
import {
  matchNotificationTargets,
  type ChannelAvailability,
  type NotificationRuleRecord,
  type TargetInput,
} from "./targets.ts";

// The outbox. Events are queued in the transaction that made them (by the
// audit trigger, or by the job), so they survive whatever happens after
// the commit. From there, in two steps that both run after the commit:
//
// 1. expandQueuedEvents: each queued event becomes one delivery per place
//    it goes (targets.ts), and is marked processed in the same transaction.
//    The unique key on deliveries means an event can never be delivered to
//    the same place twice, however often this runs.
// 2. deliverDueDeliveries: due deliveries are claimed with a lease (FOR
//    UPDATE SKIP LOCKED, so two runs never take the same one), sent, and
//    marked sent, skipped, failed, or due again later with a growing delay.
//
// A chat tool that asks for a pause (Slack's HTTP 429 and Retry-After) gets
// it: the rest of that tool's deliveries in the run are put back, due when
// the pause ends, without counting as an attempt.
//
// Delivery is at least once. A run cut off between Slack accepting a
// message and the row being marked sent sends it again once the lease runs
// out; Slack has no way to drop a repeat.
//
// Less noise:
//
// * One message per envelope per place. notification_threads remembers
//   it; a delivery takes that row's short lease before posting or editing,
//   so only one delivery at a time (in any run) can start the thread. One
//   that cannot take it is put back a few seconds, not counted as a try.
// * Bursts: a signature, an approval or an opening waits a minute
//   (BURST_HOLD_SECONDS). When it is due, it is skipped as "superseded" if
//   a newer delivery for the same envelope and place is waiting or went
//   out: messages always show the envelope as it is now, so the newest
//   says everything the older ones would have.

const DAY = 24 * 60 * 60;

export const MAX_DELIVERY_ATTEMPTS = 8;
export const DELIVERY_LEASE_SECONDS = 120;
/** How long a delivery waits when another holds its envelope's thread. */
export const THREAD_BUSY_RETRY_SECONDS = 5;
/** Queued events older than this are dropped rather than announced late. */
export const STALE_EVENT_SECONDS = 3 * DAY;
/** How long "nobody with this address" is believed before asking again. */
const IDENTITY_MISS_SECONDS = DAY;
const MAX_RETRY_DELAY_SECONDS = 6 * 60 * 60;

export type OutboxDeps = {
  appUrl: string | null;
  /** The organization's name and logo, at the top of every message. */
  brand?: NotificationBrand;
  channels: NotificationChannel[];
  context: ChannelContext;
  /** Seconds since the epoch. */
  now: () => number;
  random?: () => number;
};

/** 1, 2, 4... minutes after each failed attempt, up to six hours, plus up to 20%. */
export function retryDelaySeconds(
  attempt: number,
  random: () => number = Math.random,
): number {
  const base = Math.min(
    60 * 2 ** Math.max(attempt - 1, 0),
    MAX_RETRY_DELAY_SECONDS,
  );

  return Math.round(base * (1 + random() * 0.2));
}

export function channelAvailability(
  channels: NotificationChannel[],
  context: ChannelContext,
): ChannelAvailability[] {
  return channels.map((channel) => {
    const status = channel.status(context);

    return {
      configured: status.configured,
      directMessages: status.directMessages,
      id: channel.id,
    };
  });
}

type QueuedEventRow = {
  envelopeId: string | null;
  event: string;
  id: string;
  payload: unknown;
  queuedAt: number;
  source: "audit" | "job";
};

async function loadRules(
  database: DbExecutor,
): Promise<NotificationRuleRecord[]> {
  return queryMany<NotificationRuleRecord>(
    database,
    `
      SELECT id, channel, events, team_id AS "teamId", destination, enabled
      FROM notification_rules
      WHERE enabled
    `,
  );
}

async function gatherTargetInput(
  database: DbExecutor,
  kind: TargetInput["kind"],
  envelopeId: string | null,
  payload: NotificationPayload,
  shared: {
    adminIds: () => Promise<string[]>;
    channels: ChannelAvailability[];
    rules: NotificationRuleRecord[];
  },
): Promise<TargetInput | null> {
  const definition = NOTIFICATION_EVENTS[kind];

  if (definition.audience === "admin") {
    const adminIds = await shared.adminIds();

    return {
      adminIds,
      channels: shared.channels,
      envelope: null,
      kind,
      preferences: await listPreferencesForUsers(adminIds, database),
      rules: shared.rules,
      teammateIds: [],
    };
  }

  if (!envelopeId) {
    return null;
  }

  const envelope = await queryOne<{ ownerId: string; status: string }>(
    database,
    `SELECT user_id AS "ownerId", status FROM envelopes WHERE id = $1`,
    [envelopeId],
  );

  if (!envelope) {
    return null;
  }

  const teams = await queryMany<{ teamId: string }>(
    database,
    `SELECT team_id AS "teamId" FROM team_members WHERE user_id = $1`,
    [envelope.ownerId],
  );
  const ownerTeamIds = teams.map((team) => team.teamId);
  const teammates =
    ownerTeamIds.length > 0
      ? await queryMany<{ userId: string }>(
          database,
          `
            SELECT DISTINCT user_id AS "userId"
            FROM team_members
            WHERE team_id = ANY($1) AND user_id <> $2
          `,
          [ownerTeamIds, envelope.ownerId],
        )
      : [];
  const teammateIds = teammates.map((teammate) => teammate.userId);
  const people = await queryMany<{ email: string; id: string }>(
    database,
    `SELECT id, email FROM public."user" WHERE id = ANY($1)`,
    [[envelope.ownerId, ...teammateIds]],
  );

  return {
    actorEmails: [payload.actorEmail, payload.signerEmail].filter(
      (email): email is string => Boolean(email),
    ),
    adminIds: [],
    channels: shared.channels,
    envelope: {
      isDraft: envelope.status === "draft",
      ownerId: envelope.ownerId,
      ownerTeamIds,
    },
    kind,
    preferences: await listPreferencesForUsers(
      [envelope.ownerId, ...teammateIds],
      database,
    ),
    rules: shared.rules,
    teammateIds,
    userEmails: Object.fromEntries(
      people.map((person) => [person.id, person.email]),
    ),
  };
}

/**
 * Turns up to `limit` queued events into deliveries. Returns how many
 * events it took and how many deliveries it made.
 */
export async function expandQueuedEvents(
  database: DbPool,
  deps: OutboxDeps,
  { limit = 100 }: { limit?: number } = {},
): Promise<{ deliveries: number; events: number }> {
  return withTransaction(async (tx) => {
    const events = await queryMany<QueuedEventRow>(
      tx,
      `
        SELECT id, source, event, envelope_id AS "envelopeId", payload,
          queued_at AS "queuedAt"
        FROM notification_events
        WHERE processed_at IS NULL
        ORDER BY queued_at ASC, id ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      `,
      [limit],
    );

    if (events.length === 0) {
      return { deliveries: 0, events: 0 };
    }

    const now = deps.now();
    const channels = channelAvailability(deps.channels, deps.context);
    const anyConfigured = channels.some((channel) => channel.configured);
    const rules = anyConfigured ? await loadRules(tx) : [];
    let adminIds: Promise<string[]> | null = null;
    const shared = {
      adminIds: () => {
        adminIds ??= queryMany<{ id: string }>(
          tx,
          `SELECT id FROM public."user" WHERE role = 'admin'`,
        ).then((rows) => rows.map((row) => row.id));

        return adminIds;
      },
      channels,
      rules,
    };
    let deliveries = 0;

    for (const event of events) {
      const kind = notificationKindFor(event.source, event.event);

      if (
        !kind ||
        !anyConfigured ||
        event.queuedAt < now - STALE_EVENT_SECONDS
      ) {
        continue;
      }

      const input = await gatherTargetInput(
        tx,
        kind,
        event.envelopeId,
        readNotificationPayload(event.payload),
        shared,
      );

      if (!input) {
        continue;
      }

      // A burst event waits for the next one; see deliverDueDeliveries.
      const dueAt = BURST_KINDS.has(kind) ? now + BURST_HOLD_SECONDS : now;

      for (const target of matchNotificationTargets(input)) {
        const inserted = await tx.query(
          `
            INSERT INTO notification_deliveries (
              id, event_id, channel, target_kind, target, rule_id,
              next_attempt_at, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
            ON CONFLICT ON CONSTRAINT notification_deliveries_once DO NOTHING
          `,
          [
            randomUUID(),
            event.id,
            target.channel,
            target.targetKind,
            target.target,
            target.ruleId,
            dueAt,
            now,
          ],
        );

        deliveries += inserted.rowCount ?? 0;
      }
    }

    await tx.query(
      `UPDATE notification_events SET processed_at = $2 WHERE id = ANY($1)`,
      [events.map((event) => event.id), now],
    );

    return { deliveries, events: events.length };
  }, database);
}

type ClaimedDelivery = {
  attempts: number;
  channel: string;
  envelopeExpiresAt: number | null;
  envelopeId: string | null;
  envelopeStatus: string | null;
  envelopeTitle: string | null;
  event: string;
  eventCreatedAt: number;
  eventId: string;
  id: string;
  ownerEmail: string | null;
  ownerId: string | null;
  ownerName: string | null;
  payload: unknown;
  signedCount: number;
  signerCount: number;
  source: "audit" | "job";
  target: string;
  targetEmail: string | null;
  targetKind: "channel" | "user";
};

async function claimDueDeliveries(
  database: DbPool,
  now: number,
  limit: number,
): Promise<ClaimedDelivery[]> {
  const claimed = await queryMany<{ id: string }>(
    database,
    `
      WITH due AS (
        SELECT id FROM notification_deliveries
        WHERE (status = 'pending' AND next_attempt_at <= $1)
          OR (status = 'sending' AND locked_until <= $1)
        ORDER BY next_attempt_at ASC, id ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      )
      UPDATE notification_deliveries d SET
        status = 'sending',
        attempts = d.attempts + 1,
        locked_until = $3,
        updated_at = $1
      FROM due
      WHERE d.id = due.id
      RETURNING d.id
    `,
    [now, limit, now + DELIVERY_LEASE_SECONDS],
  );

  if (claimed.length === 0) {
    return [];
  }

  return queryMany<ClaimedDelivery>(
    database,
    `
      SELECT
        d.id,
        d.channel,
        d.target_kind AS "targetKind",
        d.target,
        d.attempts,
        e.source,
        e.event,
        e.id AS "eventId",
        e.created_at AS "eventCreatedAt",
        e.payload,
        env.user_id AS "ownerId",
        e.envelope_id AS "envelopeId",
        env.title AS "envelopeTitle",
        env.status AS "envelopeStatus",
        env.expires_at AS "envelopeExpiresAt",
        owner_account.name AS "ownerName",
        owner_account.email AS "ownerEmail",
        target_account.email AS "targetEmail",
        (
          SELECT count(*)::int FROM signers s
          WHERE s.envelope_id = env.id AND s.role = 'signer'
        ) AS "signerCount",
        (
          SELECT count(*)::int FROM signers s
          WHERE s.envelope_id = env.id AND s.role = 'signer'
            AND s.status = 'signed'
        ) AS "signedCount"
      FROM notification_deliveries d
      JOIN notification_events e ON e.id = d.event_id
      LEFT JOIN envelopes env ON env.id = e.envelope_id
      LEFT JOIN public."user" owner_account ON owner_account.id = env.user_id
      LEFT JOIN public."user" target_account
        ON d.target_kind = 'user' AND target_account.id = d.target
      WHERE d.id = ANY($1)
      ORDER BY d.next_attempt_at ASC, d.id ASC
    `,
    [claimed.map((row) => row.id)],
  );
}

type DeliveryUpdate =
  | { status: "sent" }
  | { error: string; status: "failed" | "skipped" }
  | {
      /** Put back without counting the attempt (a pause, or out of time). */
      countAttempt: boolean;
      error: string | null;
      nextAttemptAt: number;
      status: "pending";
    };

async function finishDelivery(
  database: DbExecutor,
  id: string,
  now: number,
  update: DeliveryUpdate,
): Promise<void> {
  switch (update.status) {
    case "sent":
      await database.query(
        `
          UPDATE notification_deliveries SET
            status = 'sent', sent_at = $2, updated_at = $2,
            locked_until = NULL, last_error = NULL
          WHERE id = $1
        `,
        [id, now],
      );
      return;
    case "failed":
    case "skipped":
      await database.query(
        `
          UPDATE notification_deliveries SET
            status = $3, last_error = $4, updated_at = $2, locked_until = NULL
          WHERE id = $1
        `,
        [id, now, update.status, update.error.slice(0, 200)],
      );
      return;
    case "pending":
      await database.query(
        `
          UPDATE notification_deliveries SET
            status = 'pending',
            next_attempt_at = $3,
            last_error = COALESCE($4, last_error),
            attempts = GREATEST(attempts - $5, 0),
            updated_at = $2,
            locked_until = NULL
          WHERE id = $1
        `,
        [
          id,
          now,
          update.nextAttemptAt,
          update.error?.slice(0, 200) ?? null,
          update.countAttempt ? 0 : 1,
        ],
      );
      return;
  }
}

/** What a failed attempt turns into: due again later, or given up on. */
export function updateForFailure(
  failure: ChannelFailure,
  attempts: number,
  now: number,
  random: () => number = Math.random,
): DeliveryUpdate {
  if (failure.outcome === "failed") {
    return { error: failure.error, status: "failed" };
  }

  if (failure.outcome === "rate_limited") {
    return {
      countAttempt: false,
      error: failure.error,
      nextAttemptAt: now + failure.retryAfterSeconds,
      status: "pending",
    };
  }

  if (attempts >= MAX_DELIVERY_ATTEMPTS) {
    return { error: failure.error, status: "failed" };
  }

  const delay = Math.max(
    retryDelaySeconds(attempts, random),
    failure.outcome === "retry" ? (failure.retryAfterSeconds ?? 0) : 0,
  );

  return {
    countAttempt: true,
    error: failure.error,
    nextAttemptAt: now + delay,
    status: "pending",
  };
}

async function resolveUserAddress(
  database: DbExecutor,
  channel: NotificationChannel,
  delivery: ClaimedDelivery,
  deps: OutboxDeps,
): Promise<
  | { address: string; outcome: "found" }
  | { outcome: "not_found" }
  | ChannelFailure
> {
  const email = delivery.targetEmail?.trim().toLowerCase();

  if (!email) {
    return { outcome: "not_found" };
  }

  const now = deps.now();
  const known = await queryOne<{
    checkedAt: number;
    externalId: string | null;
    lookupEmail: string;
  }>(
    database,
    `
      SELECT external_id AS "externalId", lookup_email AS "lookupEmail",
        checked_at AS "checkedAt"
      FROM notification_identities
      WHERE user_id = $1 AND channel = $2
    `,
    [delivery.target, channel.id],
  );

  if (known && known.lookupEmail === email) {
    if (known.externalId) {
      return { address: known.externalId, outcome: "found" };
    }

    if (known.checkedAt > now - IDENTITY_MISS_SECONDS) {
      return { outcome: "not_found" };
    }
  }

  const result = await channel.lookupUser(email, deps.context);

  if (result.outcome !== "found" && result.outcome !== "not_found") {
    return result;
  }

  const externalId = result.outcome === "found" ? result.externalId : null;

  await database.query(
    `
      INSERT INTO notification_identities (
        user_id, channel, lookup_email, external_id, checked_at
      ) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (user_id, channel) DO UPDATE SET
        lookup_email = excluded.lookup_email,
        external_id = excluded.external_id,
        checked_at = excluded.checked_at
    `,
    [delivery.target, channel.id, email, externalId, now],
  );

  return externalId
    ? { address: externalId, outcome: "found" }
    : { outcome: "not_found" };
}

/**
 * Whether a newer delivery for the same envelope and place is waiting or
 * went out, so this one has nothing to add. An opening never stands in for
 * anything else: "Riley opened it" says less than "Alex signed it".
 */
async function isSuperseded(
  database: DbExecutor,
  delivery: ClaimedDelivery,
): Promise<boolean> {
  if (!delivery.envelopeId) {
    return false;
  }

  const newer = await queryOne<{ one: number }>(
    database,
    `
      SELECT 1 AS one
      FROM notification_deliveries d
      JOIN notification_events e ON e.id = d.event_id
      WHERE e.envelope_id = $1
        AND d.channel = $2 AND d.target_kind = $3 AND d.target = $4
        AND d.id <> $5
        AND d.status IN ('pending', 'sending', 'sent')
        AND (e.created_at, e.id) > ($6::bigint, $7::text)
        AND NOT (e.source = 'audit' AND e.event = 'viewed')
      LIMIT 1
    `,
    [
      delivery.envelopeId,
      delivery.channel,
      delivery.targetKind,
      delivery.target,
      delivery.id,
      delivery.eventCreatedAt,
      delivery.eventId,
    ],
  );

  return newer !== null;
}

/** How a delivery's message is placed; see SendOptions in channel.ts. */
export function placementFor(
  kind: NotificationEventKind,
  targetKind: "channel" | "user",
  hasEnvelope: boolean,
): MessagePlacement {
  if (!hasEnvelope || NOTIFICATION_EVENTS[kind].audience === "admin") {
    return "standalone";
  }

  if (targetKind === "channel") {
    return "channel_thread";
  }

  return IN_PLACE_KINDS.has(kind) ? "in_place" : "new_message";
}

type ThreadKey = {
  channel: string;
  envelopeId: string;
  target: string;
  targetKind: "channel" | "user";
};

/**
 * Takes the lease on an envelope's message in one place, in one statement:
 * the row is made if there is none, or taken if its lease is free, ran
 * out, or is already this delivery's. Null: another delivery holds it.
 */
async function takeThread(
  database: DbExecutor,
  key: ThreadKey,
  owner: string,
  now: number,
): Promise<{ parentEventAt: number | null; thread: ThreadRef | null } | null> {
  const row = await queryOne<{
    conversation: string | null;
    messageTs: string | null;
    parentEventAt: number | null;
  }>(
    database,
    `
      INSERT INTO notification_threads (
        envelope_id, channel, target_kind, target, lease_owner, lease_until,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
      ON CONFLICT (envelope_id, channel, target_kind, target) DO UPDATE SET
        lease_owner = excluded.lease_owner,
        lease_until = excluded.lease_until,
        updated_at = excluded.updated_at
      WHERE notification_threads.lease_until IS NULL
        OR notification_threads.lease_until <= $7
        OR notification_threads.lease_owner = excluded.lease_owner
      RETURNING conversation, message_ts AS "messageTs",
        parent_event_at AS "parentEventAt"
    `,
    [
      key.envelopeId,
      key.channel,
      key.targetKind,
      key.target,
      owner,
      now + DELIVERY_LEASE_SECONDS,
      now,
    ],
  );

  if (!row) {
    return null;
  }

  return {
    parentEventAt: row.parentEventAt,
    thread:
      row.conversation && row.messageTs
        ? { conversation: row.conversation, ts: row.messageTs }
        : null,
  };
}

/**
 * Lets go of the lease, remembering the message from now on when the send
 * went out (`sent`), or leaving the row as it was when it did not.
 */
async function releaseThread(
  database: DbExecutor,
  key: ThreadKey,
  owner: string,
  now: number,
  sent: { eventAt: number; thread: ThreadRef | null } | null,
): Promise<void> {
  if (!sent) {
    await database.query(
      `
        UPDATE notification_threads SET
          lease_owner = NULL, lease_until = NULL, updated_at = $6
        WHERE envelope_id = $1 AND channel = $2 AND target_kind = $3
          AND target = $4 AND lease_owner = $5
      `,
      [key.envelopeId, key.channel, key.targetKind, key.target, owner, now],
    );
    return;
  }

  await database.query(
    `
      UPDATE notification_threads SET
        conversation = $7,
        message_ts = $8,
        parent_event_at = CASE
          WHEN $8::text IS NULL THEN NULL
          ELSE GREATEST(COALESCE(parent_event_at, $9), $9)
        END,
        lease_owner = NULL,
        lease_until = NULL,
        updated_at = $6
      WHERE envelope_id = $1 AND channel = $2 AND target_kind = $3
        AND target = $4 AND lease_owner = $5
    `,
    [
      key.envelopeId,
      key.channel,
      key.targetKind,
      key.target,
      owner,
      now,
      sent.thread?.conversation ?? null,
      sent.thread?.ts ?? null,
      sent.eventAt,
    ],
  );
}

/** The soonest a waiting delivery is due within `withinSeconds`, or null. */
export async function nextDeliveryDueAt(
  database: DbExecutor,
  now: number,
  withinSeconds: number,
): Promise<number | null> {
  const row = await queryOne<{ dueAt: number | null }>(
    database,
    `
      SELECT min(next_attempt_at) AS "dueAt"
      FROM notification_deliveries
      WHERE status = 'pending' AND next_attempt_at > $1
        AND next_attempt_at <= $2
    `,
    [now, now + withinSeconds],
  );

  return row?.dueAt ?? null;
}

function envelopeFor(delivery: ClaimedDelivery): NotificationEnvelope | null {
  if (!delivery.envelopeId || delivery.envelopeTitle === null) {
    return null;
  }

  return {
    expiresAt: delivery.envelopeExpiresAt,
    id: delivery.envelopeId,
    ownerEmail: delivery.ownerEmail ?? "",
    ownerName: delivery.ownerName ?? "",
    signedCount: delivery.signedCount,
    signerCount: delivery.signerCount,
    status: delivery.envelopeStatus ?? "sent",
    title: delivery.envelopeTitle,
  };
}

export type DeliverySummary = {
  failed: number;
  postponed: number;
  sent: number;
  skipped: number;
};

/**
 * Sends what is due, a few at a time, until nothing is or `outOfTime()`
 * says to stop. What was claimed but not tried is put back as it was.
 */
export async function deliverDueDeliveries(
  database: DbPool,
  deps: OutboxDeps,
  {
    batchSize = 10,
    outOfTime = () => false,
  }: { batchSize?: number; outOfTime?: () => boolean } = {},
): Promise<DeliverySummary> {
  const summary: DeliverySummary = {
    failed: 0,
    postponed: 0,
    sent: 0,
    skipped: 0,
  };
  const random = deps.random ?? Math.random;
  // A tool that asked for a pause, or refused the credentials, in this run.
  const blocked = new Map<string, ChannelFailure>();
  const channelsById = new Map(
    deps.channels.map((channel) => [channel.id as string, channel]),
  );

  async function apply(delivery: ClaimedDelivery, update: DeliveryUpdate) {
    await finishDelivery(database, delivery.id, deps.now(), update);

    if (update.status === "sent") {
      summary.sent += 1;
    } else if (update.status === "pending") {
      summary.postponed += 1;
    } else {
      summary[update.status] += 1;
    }
  }

  while (!outOfTime()) {
    const batch = await claimDueDeliveries(database, deps.now(), batchSize);

    if (batch.length === 0) {
      break;
    }

    for (const delivery of batch) {
      const now = deps.now();

      if (outOfTime()) {
        await apply(delivery, {
          countAttempt: false,
          error: null,
          nextAttemptAt: now,
          status: "pending",
        });
        continue;
      }

      const channel = channelsById.get(delivery.channel);

      if (!channel || !channel.status(deps.context).configured) {
        await apply(delivery, { error: "not_configured", status: "skipped" });
        continue;
      }

      const kind = notificationKindFor(delivery.source, delivery.event);

      if (!kind) {
        await apply(delivery, { error: "unknown_event", status: "skipped" });
        continue;
      }

      if (BURST_KINDS.has(kind) && (await isSuperseded(database, delivery))) {
        await apply(delivery, { error: "superseded", status: "skipped" });
        continue;
      }

      const block = blocked.get(channel.id);

      if (block) {
        await apply(
          delivery,
          updateForFailure(block, delivery.attempts, now, random),
        );
        continue;
      }

      let address = delivery.target;

      if (delivery.targetKind === "user") {
        if (!channel.status(deps.context).directMessages) {
          await apply(delivery, {
            error: "direct_messages_off",
            status: "skipped",
          });
          continue;
        }

        const resolved = await resolveUserAddress(
          database,
          channel,
          delivery,
          deps,
        );

        if (resolved.outcome === "not_found") {
          await apply(delivery, {
            error: "no_matching_account",
            status: "skipped",
          });
          continue;
        }

        if (resolved.outcome !== "found") {
          if (
            resolved.outcome === "rate_limited" ||
            resolved.outcome === "auth"
          ) {
            blocked.set(channel.id, resolved);
          }

          await apply(
            delivery,
            updateForFailure(resolved, delivery.attempts, now, random),
          );
          continue;
        }

        address = resolved.address;
      }

      const envelope = envelopeFor(delivery);
      const message = buildNotificationMessage({
        appUrl: deps.appUrl,
        brand: deps.brand,
        envelope,
        forSender:
          delivery.targetKind === "user" &&
          delivery.target === delivery.ownerId,
        kind,
        occurredAt: delivery.eventCreatedAt,
        payload: readNotificationPayload(delivery.payload),
      });
      const placement = placementFor(
        kind,
        delivery.targetKind,
        envelope !== null,
      );
      const threadKey: ThreadKey | null =
        placement === "standalone" || !envelope
          ? null
          : {
              channel: delivery.channel,
              envelopeId: envelope.id,
              target: delivery.target,
              targetKind: delivery.targetKind,
            };
      let options: SendOptions = STANDALONE;

      if (threadKey) {
        const taken = await takeThread(database, threadKey, delivery.id, now);

        if (!taken) {
          // Another delivery is posting about this envelope here right now.
          await apply(delivery, {
            countAttempt: false,
            error: null,
            nextAttemptAt: now + THREAD_BUSY_RETRY_SECONDS,
            status: "pending",
          });
          continue;
        }

        options = {
          placement,
          thread: taken.thread,
          updateThread:
            taken.parentEventAt === null ||
            delivery.eventCreatedAt >= taken.parentEventAt,
        };
      }

      let result: SendResult;

      try {
        result = await channel.send(address, message, deps.context, options);
      } catch {
        result = {
          error: "send_threw",
          outcome: "retry" as const,
          retryAfterSeconds: null,
        };
      }

      if (threadKey) {
        await releaseThread(
          database,
          threadKey,
          delivery.id,
          deps.now(),
          result.outcome === "sent"
            ? { eventAt: delivery.eventCreatedAt, thread: result.thread }
            : null,
        );
      }

      if (result.outcome === "sent") {
        await apply(delivery, { status: "sent" });
        continue;
      }

      if (result.outcome === "rate_limited" || result.outcome === "auth") {
        blocked.set(channel.id, result);
      }

      await apply(
        delivery,
        updateForFailure(result, delivery.attempts, now, random),
      );
    }
  }

  return summary;
}

/**
 * Marks every queued event processed without delivering anything, for an
 * install with no channel set up: nothing piles up waiting for one.
 */
export async function discardQueuedEvents(
  database: DbExecutor,
  now: number,
): Promise<number> {
  const result = await database.query(
    `UPDATE notification_events SET processed_at = $1 WHERE processed_at IS NULL`,
    [now],
  );

  return result.rowCount ?? 0;
}

/**
 * Deletes what is no longer needed, a month after it was processed. A
 * job's "once per envelope" marker stays while its envelope is still out
 * for signature, so the same envelope is not announced again.
 */
export async function purgeOldNotifications(
  database: DbExecutor,
  now: number,
): Promise<number> {
  const result = await database.query(
    `
      DELETE FROM notification_events e
      WHERE e.processed_at IS NOT NULL
        AND e.processed_at < $1
        AND NOT EXISTS (
          SELECT 1 FROM notification_deliveries d
          WHERE d.event_id = e.id AND d.status IN ('pending', 'sending')
        )
        AND (
          e.source = 'audit'
          OR e.envelope_id IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM envelopes env
            WHERE env.id = e.envelope_id AND env.status = 'sent'
          )
        )
    `,
    [now - 30 * DAY],
  );

  // A thread nobody has touched for 90 days is for an envelope long done;
  // a later event about it starts a new one.
  await database.query(
    `
      DELETE FROM notification_threads
      WHERE updated_at < $1
        AND (lease_until IS NULL OR lease_until <= $2)
    `,
    [now - 90 * DAY, now],
  );

  return result.rowCount ?? 0;
}
