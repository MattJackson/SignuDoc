import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, mock, test } from "node:test";

import type pg from "pg";
import { z } from "zod";

import { withTransaction } from "../db/connection.ts";
import { openTestDatabase } from "../db/test-database.ts";
import { recordAuditEvent } from "../services/audit.ts";
import type {
  LookupResult,
  NotificationChannel,
  SendResult,
} from "./channel.ts";
import { queueConditionEvents } from "./conditions.ts";
import { headlineText } from "./message.ts";
import {
  deliverDueDeliveries,
  discardQueuedEvents,
  expandQueuedEvents,
  MAX_DELIVERY_ATTEMPTS,
  nextDeliveryDueAt,
  type OutboxDeps,
  purgeOldNotifications,
} from "./outbox.ts";
import { savePreferenceChoices } from "./preferences.ts";
import {
  createNotificationRule,
  NotificationSettingsError,
  updateNotificationRule,
} from "./rules.ts";

// The outbox against a real Postgres, with a fake chat tool: events are
// queued by the audit trigger in the audit event's own transaction, turned
// into one delivery per place exactly once, kept to the right team, and
// sent with retries, pauses and backoff. Run with `npm run test:db`.

const DAY = 24 * 60 * 60;

let database: pg.Pool;
const createdUsers: string[] = [];
const createdTeams: string[] = [];
const createdRules: string[] = [];
const marker = `notify${randomUUID().slice(0, 8)}`;

type Account = { email: string; id: string };

let owner: Account;
let teammate: Account;
let outsider: Account;
let admin: Account;
let salesTeam: string;
let legalTeam: string;

function fakeChannel() {
  const sent: { destination: string; headline: string }[] = [];
  const lookups: string[] = [];
  const results: SendResult[] = [];
  const users = new Map<string, string>();
  const channel: NotificationChannel = {
    destinationSchema: z.string(),
    id: "slack",
    async lookupUser(email): Promise<LookupResult> {
      lookups.push(email);

      const id = users.get(email);

      return id
        ? { externalId: id, outcome: "found" }
        : { outcome: "not_found" };
    },
    name: "Fake Slack",
    async send(destination, message, _context, options): Promise<SendResult> {
      sent.push({ destination, headline: headlineText(message.headline) });

      return (
        results.shift() ?? {
          outcome: "sent",
          thread:
            options && options.placement !== "standalone"
              ? (options.thread ?? {
                  conversation: destination,
                  ts: String(sent.length),
                })
              : null,
        }
      );
    },
    status: () => ({
      configured: true,
      directMessages: true,
      source: "settings",
    }),
  };

  return { channel, lookups, results, sent, users };
}

function depsFor(channel: NotificationChannel, now: number): OutboxDeps {
  return {
    appUrl: "https://sign.example.test",
    channels: [channel],
    context: { env: {}, stored: {} },
    now: () => now,
    random: () => 0,
  };
}

async function createAccount(role: "admin" | "user"): Promise<Account> {
  const id = randomUUID();
  const email = `${id}@example.test`;

  createdUsers.push(id);
  await database.query(
    `
      insert into public."user" (id, name, email, "emailVerified", role)
      values ($1, $2, $3, true, $4)
    `,
    [id, `Person ${id.slice(0, 6)}`, email, role],
  );

  return { email, id };
}

async function createTeam(name: string, members: Account[]): Promise<string> {
  const id = randomUUID();
  const now = Math.floor(Date.now() / 1000);

  createdTeams.push(id);
  await database.query(
    `insert into teams (id, name, created_at, updated_at) values ($1, $2, $3, $3)`,
    [id, `${name} ${marker}`, now],
  );

  for (const member of members) {
    await database.query(
      `insert into team_members (team_id, user_id, added_at) values ($1, $2, $3)`,
      [id, member.id, now],
    );
  }

  return id;
}

async function createEnvelope(
  ownerId: string,
  {
    expiresAt = null,
    sentAt,
    status = "sent",
  }: { expiresAt?: number | null; sentAt: number; status?: string },
): Promise<string> {
  const id = randomUUID();

  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash, sent_at,
        expires_at, created_at, updated_at
      ) values ($1, $2, $3, $4, $5, 'contract.pdf', 4, 1, $6, $7, $8, $7, $7)
    `,
    [
      id,
      ownerId,
      `Contract ${marker}`,
      status,
      `test/${id}.pdf`,
      "a".repeat(64),
      status === "draft" ? null : sentAt,
      expiresAt,
    ],
  );
  await database.query(
    `
      insert into signers (
        id, envelope_id, name, email, sign_order, signing_step, status
      ) values ($1, $2, 'Riley Recipient', $3, 1, 1, 'notified')
    `,
    [randomUUID(), id, `riley-${id}@example.test`],
  );

  return id;
}

async function deliveriesFor(envelopeId: string) {
  const result = await database.query<{
    attempts: number;
    lastError: string | null;
    nextAttemptAt: number;
    status: string;
    target: string;
    targetKind: string;
  }>(
    `
      select d.target_kind as "targetKind", d.target, d.status, d.attempts,
        d.last_error as "lastError", d.next_attempt_at as "nextAttemptAt"
      from notification_deliveries d
      join notification_events e on e.id = d.event_id
      where e.envelope_id = $1
      order by d.target_kind, d.target
    `,
    [envelopeId],
  );

  return result.rows;
}

function places(rows: { target: string; targetKind: string }[]) {
  return rows.map((row) => `${row.targetKind}:${row.target}`).sort();
}

/** Whatever an earlier test (or another file) left queued is not for the next one. */
async function clearOutbox() {
  await discardQueuedEvents(database, Math.floor(Date.now() / 1000));
  await database.query(
    `update notification_deliveries set status = 'skipped'
     where status in ('pending', 'sending')`,
  );
}

before(async () => {
  database = await openTestDatabase();
  globalThis.__signudocPgPool = database;

  await clearOutbox();

  owner = await createAccount("user");
  teammate = await createAccount("user");
  outsider = await createAccount("user");
  admin = await createAccount("admin");
  salesTeam = await createTeam("Sales", [owner, teammate]);
  legalTeam = await createTeam("Legal", [outsider]);

  const actor = { email: admin.email, id: admin.id };

  for (const rule of [
    { destination: "C0SALES1", teamId: salesTeam },
    { destination: "C0LEGAL1", teamId: legalTeam },
    { destination: "C0EVERY1", teamId: null },
  ]) {
    const rules = await createNotificationRule(
      actor,
      {
        channel: "slack",
        destination: rule.destination,
        destinationName: rule.destination.toLowerCase(),
        events: ["envelope_completed", "envelope_declined"],
        teamId: rule.teamId,
      },
      database,
    );
    const created = rules
      .filter((item) => item.destination === rule.destination)
      .at(-1);

    assert.ok(created);
    createdRules.push(created.id);
  }
});

after(async () => {
  await database.query(`delete from notification_rules where id = any($1)`, [
    createdRules,
  ]);
  await database.query(`delete from teams where id = any($1)`, [createdTeams]);
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();
});

test("an audit event is queued in its own transaction, with who did it and nothing more", async () => {
  const now = Math.floor(Date.now() / 1000);
  const envelopeId = await createEnvelope(owner.id, { sentAt: now });

  await assert.rejects(
    withTransaction(async (tx) => {
      await recordAuditEvent(
        {
          actorType: "signer",
          envelopeId,
          event: "declined",
          metadata: { reason: "Never shown", signerName: "Riley" },
        },
        tx,
      );
      throw new Error("rolled back");
    }, database),
    /rolled back/,
  );

  const none = await database.query(
    `select 1 from notification_events where envelope_id = $1`,
    [envelopeId],
  );

  assert.equal(none.rowCount, 0);

  await recordAuditEvent(
    {
      actorEmail: "riley@example.test",
      actorType: "signer",
      envelopeId,
      event: "declined",
      metadata: {
        reason: "Never shown",
        signerEmail: "riley@example.test",
        signerName: "Riley",
      },
    },
    database,
  );
  await recordAuditEvent(
    {
      actorType: "system",
      envelopeId,
      event: "email_sent",
      metadata: { recipient: "riley@example.test", template: "x" },
    },
    database,
  );

  const queued = await database.query<{
    event: string;
    payload: Record<string, unknown>;
    source: string;
  }>(
    `select source, event, payload from notification_events where envelope_id = $1`,
    [envelopeId],
  );

  assert.equal(queued.rowCount, 1, "the email note is never queued");
  assert.equal(queued.rows[0]?.source, "audit");
  assert.equal(queued.rows[0]?.event, "declined");
  assert.deepEqual(queued.rows[0]?.payload, {
    actorEmail: "riley@example.test",
    actorType: "signer",
    signerEmail: "riley@example.test",
    signerName: "Riley",
  });
});

test("an event becomes one delivery per place, once, and a team's channel only hears about its team", async () => {
  const now = Math.floor(Date.now() / 1000);
  const fake = fakeChannel();

  await clearOutbox();
  const deps = depsFor(fake.channel, now);

  await expandQueuedEvents(database, deps);

  await savePreferenceChoices(
    teammate.id,
    {
      channel: "slack",
      preferences: [
        { enabled: true, event: "envelope_completed", scope: "team" },
      ],
    },
    false,
    database,
  );

  const salesEnvelope = await createEnvelope(owner.id, { sentAt: now });
  const legalEnvelope = await createEnvelope(outsider.id, { sentAt: now });

  for (const envelopeId of [salesEnvelope, legalEnvelope]) {
    await recordAuditEvent(
      { actorType: "system", envelopeId, event: "completed" },
      database,
    );
  }

  const expanded = await expandQueuedEvents(database, deps);

  assert.equal(expanded.events, 2);
  // places() sorts, and the two user ids are random, so the expected list
  // is sorted the same way.
  assert.deepEqual(
    places(await deliveriesFor(salesEnvelope)),
    [
      "channel:C0EVERY1",
      "channel:C0SALES1",
      `user:${owner.id}`,
      `user:${teammate.id}`,
    ].sort(),
  );
  assert.deepEqual(places(await deliveriesFor(legalEnvelope)), [
    "channel:C0EVERY1",
    "channel:C0LEGAL1",
    `user:${outsider.id}`,
  ]);

  // Processed events are not taken again, and an event processed twice
  // (a run cut off before it was marked) makes no second delivery.
  assert.deepEqual(await expandQueuedEvents(database, deps), {
    deliveries: 0,
    events: 0,
  });
  await database.query(
    `update notification_events set processed_at = null where envelope_id = $1`,
    [salesEnvelope],
  );
  assert.deepEqual(await expandQueuedEvents(database, deps), {
    deliveries: 0,
    events: 1,
  });
  assert.equal((await deliveriesFor(salesEnvelope)).length, 4);

  // Delivered: people are looked up once by email and remembered.
  fake.users.set(owner.email, "UOWNER");
  fake.users.set(teammate.email, "UTEAMMATE");

  const summary = await deliverDueDeliveries(database, deps);

  assert.equal(summary.sent, 6);
  assert.equal(summary.skipped, 1, "the outsider has no Slack account");
  assert.deepEqual(fake.sent.map((item) => item.destination).sort(), [
    "C0EVERY1",
    "C0EVERY1",
    "C0LEGAL1",
    "C0SALES1",
    "UOWNER",
    "UTEAMMATE",
  ]);
  assert.ok(fake.sent.every((item) => item.headline.includes(marker)));

  const outsiderRow = (await deliveriesFor(legalEnvelope)).find(
    (row) => row.targetKind === "user",
  );

  assert.equal(outsiderRow?.status, "skipped");
  assert.equal(outsiderRow?.lastError, "no_matching_account");

  const lookupsBefore = fake.lookups.length;

  await recordAuditEvent(
    { actorType: "system", envelopeId: salesEnvelope, event: "declined" },
    database,
  );
  await expandQueuedEvents(database, deps);
  await deliverDueDeliveries(database, deps);
  assert.equal(
    fake.lookups.length,
    lookupsBefore,
    "the owner's Slack id was remembered",
  );
});

test("failed sends are retried with backoff, paused for rate limits, and given up on", async () => {
  const now = Math.floor(Date.now() / 1000);
  const fake = fakeChannel();

  await clearOutbox();
  const envelopeId = await createEnvelope(outsider.id, { sentAt: now });

  await expandQueuedEvents(database, depsFor(fake.channel, now));
  await recordAuditEvent(
    { actorType: "system", envelopeId, event: "declined" },
    database,
  );
  await expandQueuedEvents(database, depsFor(fake.channel, now));

  const channelRows = async () =>
    (await deliveriesFor(envelopeId)).filter(
      (row) => row.target === "C0LEGAL1",
    );

  // The outsider is not in Slack; only the channel posts matter here.
  fake.results.push(
    { error: "internal_error", outcome: "retry", retryAfterSeconds: null },
    { error: "internal_error", outcome: "retry", retryAfterSeconds: null },
  );
  await deliverDueDeliveries(database, depsFor(fake.channel, now));

  let [legal] = await channelRows();

  assert.equal(legal?.status, "pending");
  assert.equal(legal?.attempts, 1);
  assert.equal(legal?.lastError, "internal_error");
  assert.ok(legal && legal.nextAttemptAt >= now + 60);

  // Not due yet: nothing is tried.
  const sentBefore = fake.sent.length;

  await deliverDueDeliveries(database, depsFor(fake.channel, now + 30));
  assert.equal(fake.sent.length, sentBefore);

  // A rate limit puts it back without counting the attempt, and stops
  // everything else to that tool in the same run.
  fake.results.length = 0;
  fake.results.push({
    error: "ratelimited",
    outcome: "rate_limited",
    retryAfterSeconds: 120,
  });
  await deliverDueDeliveries(database, depsFor(fake.channel, now + 400));
  [legal] = await channelRows();
  assert.equal(legal?.status, "pending");
  assert.equal(legal?.attempts, 1);
  assert.ok(legal && legal.nextAttemptAt >= now + 400 + 120);

  // After the last attempt, it fails for good.
  await database.query(
    `
      update notification_deliveries set attempts = $2
      where target = 'C0LEGAL1' and event_id in (
        select id from notification_events where envelope_id = $1
      )
    `,
    [envelopeId, MAX_DELIVERY_ATTEMPTS - 1],
  );
  fake.results.length = 0;
  fake.results.push(
    { error: "internal_error", outcome: "retry", retryAfterSeconds: null },
    { error: "internal_error", outcome: "retry", retryAfterSeconds: null },
  );
  await deliverDueDeliveries(database, depsFor(fake.channel, now + 10 * DAY));
  [legal] = await channelRows();
  assert.equal(legal?.status, "failed");
  assert.equal(legal?.attempts, MAX_DELIVERY_ATTEMPTS);
});

test("a delivery whose lease ran out is taken again", async () => {
  const now = Math.floor(Date.now() / 1000);
  const fake = fakeChannel();

  await clearOutbox();
  const envelopeId = await createEnvelope(owner.id, { sentAt: now });

  await recordAuditEvent(
    { actorType: "system", envelopeId, event: "completed" },
    database,
  );
  await expandQueuedEvents(database, depsFor(fake.channel, now));
  await database.query(
    `
      update notification_deliveries set status = 'sending', locked_until = $2
      where event_id in (select id from notification_events where envelope_id = $1)
    `,
    [envelopeId, now + 60],
  );

  await deliverDueDeliveries(database, depsFor(fake.channel, now));
  assert.equal(fake.sent.length, 0, "still leased to another run");

  await deliverDueDeliveries(database, depsFor(fake.channel, now + 61));
  assert.ok(fake.sent.length > 0);
});

test("deadlines, idle envelopes and failed backups are queued once each", async () => {
  const now = Math.floor(Date.now() / 1000);
  const idle = await createEnvelope(owner.id, { sentAt: now - 10 * DAY });
  const busy = await createEnvelope(owner.id, { sentAt: now - 10 * DAY });
  const expiring = await createEnvelope(owner.id, {
    expiresAt: now + 2 * DAY,
    sentAt: now - 5 * DAY,
  });
  const runId = randomUUID();

  await recordAuditEvent(
    {
      actorType: "signer",
      createdAt: now - DAY,
      envelopeId: busy,
      event: "viewed",
    },
    database,
  );
  await database.query(
    `
      insert into backup_runs (id, started_at, finished_at, status, trigger, destination)
      values ($1, $2, $2, 'failed', 'schedule', 'gcs')
    `,
    [runId, now - 60],
  );

  try {
    const first = await queueConditionEvents(database, {
      expiringDays: 3,
      now,
      stuckDays: 7,
    });

    assert.ok(first.stuck >= 1);
    assert.ok(first.expiringSoon >= 1);
    assert.ok(first.backupFailed >= 1);

    const kinds = await database.query<{ dedupeKey: string }>(
      `
        select dedupe_key as "dedupeKey" from notification_events
        where source = 'job' and (envelope_id = any($1) or dedupe_key = $2)
        order by dedupe_key
      `,
      [[idle, busy, expiring], `backup_failed:${runId}`],
    );

    assert.deepEqual(
      kinds.rows.map((row) => row.dedupeKey).sort(),
      [
        `backup_failed:${runId}`,
        `envelope_expiring_soon:${expiring}:${String(now + 2 * DAY)}`,
        `envelope_stuck:${idle}`,
      ].sort(),
    );

    const second = await queueConditionEvents(database, {
      expiringDays: 3,
      now: now + 60,
      stuckDays: 7,
    });

    assert.deepEqual(second, { backupFailed: 0, expiringSoon: 0, stuck: 0 });
  } finally {
    await database.query(
      `delete from notification_events where dedupe_key = $1`,
      [`backup_failed:${runId}`],
    );
    await database.query(`delete from backup_runs where id = $1`, [runId]);
  }
});

test("a team's rule cannot take the install's own events", async () => {
  await assert.rejects(
    createNotificationRule(
      { email: admin.email, id: admin.id },
      {
        channel: "slack",
        destination: "C0SALES1",
        events: ["backup_failed"],
        teamId: salesTeam,
      },
      database,
    ),
    (error: unknown) =>
      error instanceof NotificationSettingsError &&
      Boolean(error.fieldErrors.events),
  );
});

test("editing a paused rule without saying enabled leaves it paused", async () => {
  const actor = { email: admin.email, id: admin.id };
  const created = await createNotificationRule(
    actor,
    {
      channel: "slack",
      destination: "C0PAUSED1",
      events: ["envelope_completed"],
      teamId: null,
    },
    database,
  );
  const rule = created.find((item) => item.destination === "C0PAUSED1");

  assert.ok(rule);
  createdRules.push(rule.id);

  const body = {
    channel: "slack",
    destination: "C0PAUSED1",
    events: ["envelope_completed"],
    teamId: null,
  };

  await updateNotificationRule(
    actor,
    rule.id,
    { ...body, enabled: false },
    database,
  );

  // The settings panel's edit sends no `enabled`.
  const edited = await updateNotificationRule(
    actor,
    rule.id,
    { ...body, events: ["envelope_completed", "envelope_declined"] },
    database,
  );
  const result = edited.find((item) => item.id === rule.id);

  assert.deepEqual(result?.events.slice().sort(), [
    "envelope_completed",
    "envelope_declined",
  ]);
  assert.equal(result?.enabled, false, "still paused");
});

test("a missing scope on the address lookup does not stop posts to channels", async () => {
  const now = Math.floor(Date.now() / 1000);
  const fake = fakeChannel();
  const channel: NotificationChannel = {
    ...fake.channel,
    async lookupUser(email): Promise<LookupResult> {
      fake.lookups.push(email);

      return { error: "missing_scope", outcome: "auth" };
    },
  };

  await clearOutbox();
  await database.query(
    `delete from notification_identities where user_id = any($1)`,
    [[owner.id, teammate.id]],
  );

  const envelopeId = await createEnvelope(owner.id, { sentAt: now });

  await recordAuditEvent(
    { actorType: "system", envelopeId, event: "completed" },
    database,
  );
  await expandQueuedEvents(database, depsFor(channel, now));
  // The direct messages come first in the run.
  await database.query(
    `
      update notification_deliveries set next_attempt_at = $2
      where target_kind = 'user' and event_id in (
        select id from notification_events where envelope_id = $1
      )
    `,
    [envelopeId, now - 10],
  );
  await deliverDueDeliveries(database, depsFor(channel, now));

  const rows = await deliveriesFor(envelopeId);
  const channelRows = rows.filter((row) => row.targetKind === "channel");

  assert.ok(channelRows.length > 0);
  assert.ok(fake.lookups.length > 0, "the lookup was tried");

  for (const row of channelRows) {
    assert.equal(row.status, "sent", `${row.target}: ${String(row.lastError)}`);
    assert.equal(row.attempts, 1);
  }
});

test("a remembered address that Slack no longer knows is looked up again", async () => {
  const now = Math.floor(Date.now() / 1000);
  const fake = fakeChannel();
  const channel: NotificationChannel = {
    ...fake.channel,
    async send(destination, message, context, options): Promise<SendResult> {
      if (destination === "USTALE") {
        fake.sent.push({ destination, headline: "stale" });

        return { error: "channel_not_found", outcome: "failed" };
      }

      return fake.channel.send(destination, message, context, options);
    },
  };

  await clearOutbox();
  fake.users.set(owner.email.toLowerCase(), "UFRESH");
  await database.query(
    `
      insert into notification_identities (
        user_id, channel, lookup_email, external_id, checked_at
      ) values ($1, 'slack', $2, 'USTALE', $3)
      on conflict (user_id, channel) do update set
        lookup_email = excluded.lookup_email,
        external_id = excluded.external_id,
        checked_at = excluded.checked_at
    `,
    [owner.id, owner.email.toLowerCase(), now],
  );

  const first = await createEnvelope(owner.id, { sentAt: now });

  await recordAuditEvent(
    { actorType: "system", envelopeId: first, event: "completed" },
    database,
  );
  await expandQueuedEvents(database, depsFor(channel, now));
  await deliverDueDeliveries(database, depsFor(channel, now));

  const firstDm = (await deliveriesFor(first)).find(
    (row) => row.targetKind === "user" && row.target === owner.id,
  );

  assert.equal(firstDm?.status, "failed");

  const second = await createEnvelope(owner.id, { sentAt: now });

  await recordAuditEvent(
    { actorType: "system", envelopeId: second, event: "completed" },
    database,
  );
  await expandQueuedEvents(database, depsFor(channel, now));
  await deliverDueDeliveries(database, depsFor(channel, now));

  const secondDm = (await deliveriesFor(second)).find(
    (row) => row.targetKind === "user" && row.target === owner.id,
  );

  assert.equal(secondDm?.status, "sent");
  assert.ok(
    fake.sent.some((item) => item.destination === "UFRESH"),
    "the second message went to the new Slack id",
  );
});

test("a send that throws is logged and retried", async () => {
  const now = Math.floor(Date.now() / 1000);
  const fake = fakeChannel();
  const channel: NotificationChannel = {
    ...fake.channel,
    async send(): Promise<SendResult> {
      throw new TypeError("boom");
    },
  };
  const warn = mock.method(console, "warn", () => {});

  try {
    await clearOutbox();

    const envelopeId = await createEnvelope(outsider.id, { sentAt: now });

    await recordAuditEvent(
      { actorType: "system", envelopeId, event: "declined" },
      database,
    );
    await expandQueuedEvents(database, depsFor(channel, now));
    await deliverDueDeliveries(database, depsFor(channel, now));

    const legal = (await deliveriesFor(envelopeId)).find(
      (row) => row.target === "C0LEGAL1",
    );

    assert.equal(legal?.status, "pending");
    assert.equal(legal?.lastError, "send_threw");
    assert.ok(
      warn.mock.calls.some((call) =>
        call.arguments.some((argument) => String(argument).includes("boom")),
      ),
      "the cause was logged",
    );
  } finally {
    warn.mock.restore();
  }
});

test("a delivery that throws before sending does not stop the rest of the batch", async () => {
  const now = Math.floor(Date.now() / 1000);
  const fake = fakeChannel();
  const channel: NotificationChannel = {
    ...fake.channel,
    async lookupUser(): Promise<LookupResult> {
      throw new RangeError("lookup exploded");
    },
  };
  const warn = mock.method(console, "warn", () => {});

  try {
    await clearOutbox();
    await database.query(
      `delete from notification_identities where user_id = any($1)`,
      [[owner.id, teammate.id]],
    );

    const envelopeId = await createEnvelope(owner.id, { sentAt: now });

    await recordAuditEvent(
      { actorType: "system", envelopeId, event: "completed" },
      database,
    );
    await expandQueuedEvents(database, depsFor(channel, now));
    await database.query(
      `
        update notification_deliveries set next_attempt_at = $2
        where target_kind = 'user' and event_id in (
          select id from notification_events where envelope_id = $1
        )
      `,
      [envelopeId, now - 10],
    );
    await deliverDueDeliveries(database, depsFor(channel, now));

    const rows = await deliveriesFor(envelopeId);

    for (const row of rows.filter((item) => item.targetKind === "channel")) {
      assert.equal(row.status, "sent", row.target);
    }

    const dm = rows.find((row) => row.target === owner.id);

    assert.equal(dm?.status, "pending");
    assert.equal(dm?.attempts, 1, "the try is counted");
  } finally {
    warn.mock.restore();
  }
});

test("a delivery left 'sending' after its last attempt is failed, not taken again", async () => {
  const now = Math.floor(Date.now() / 1000);
  const fake = fakeChannel();

  await clearOutbox();

  const envelopeId = await createEnvelope(owner.id, { sentAt: now });

  await recordAuditEvent(
    { actorType: "system", envelopeId, event: "completed" },
    database,
  );
  await expandQueuedEvents(database, depsFor(fake.channel, now));
  await database.query(
    `
      update notification_deliveries
      set status = 'sending', locked_until = $2, attempts = $3
      where event_id in (select id from notification_events where envelope_id = $1)
    `,
    [envelopeId, now - 1, MAX_DELIVERY_ATTEMPTS],
  );
  await deliverDueDeliveries(database, depsFor(fake.channel, now));

  const rows = await deliveriesFor(envelopeId);

  assert.ok(rows.length > 0);
  assert.ok(
    rows.every((row) => row.status === "failed"),
    rows.map((row) => row.status).join(","),
  );
  assert.equal(fake.sent.length, 0);
});

/** Sends the owner one direct message about a fresh envelope. */
async function directMessageToOwner(
  channel: NotificationChannel,
  now: number,
): Promise<string> {
  const envelopeId = await createEnvelope(owner.id, { sentAt: now });

  await recordAuditEvent(
    { actorType: "system", envelopeId, event: "completed" },
    database,
  );
  await expandQueuedEvents(database, depsFor(channel, now));
  await database.query(
    `
      update notification_deliveries set next_attempt_at = $2
      where target_kind = 'user' and event_id in (
        select id from notification_events where envelope_id = $1
      )
    `,
    [envelopeId, now - 10],
  );
  await deliverDueDeliveries(database, depsFor(channel, now));

  return envelopeId;
}

async function rememberIdentity(
  lookupEmail: string,
  externalId: string | null,
  checkedAt: number,
) {
  await database.query(
    `delete from notification_identities where user_id = any($1)`,
    [[owner.id, teammate.id, admin.id]],
  );
  await database.query(
    `
      insert into notification_identities (
        user_id, channel, lookup_email, external_id, checked_at
      ) values ($1, 'slack', $2, $3, $4)
    `,
    [owner.id, lookupEmail, externalId, checkedAt],
  );
}

test("a remembered address is only trusted for the email it was found by", async () => {
  const now = Math.floor(Date.now() / 1000);
  const fake = fakeChannel();

  await clearOutbox();
  fake.users.set(owner.email.toLowerCase(), "UNEW");
  await rememberIdentity("old-address@example.test", "UOLD", now);
  await directMessageToOwner(fake.channel, now);

  assert.ok(
    fake.lookups.includes(owner.email.toLowerCase()),
    "the new address was looked up",
  );
  assert.ok(fake.sent.some((item) => item.destination === "UNEW"));
  assert.ok(
    !fake.sent.some((item) => item.destination === "UOLD"),
    "nothing went to the member found by the old address",
  );
});

test("'nobody has this address' is believed for a day, then asked again", async () => {
  const now = Math.floor(Date.now() / 1000);
  const email = owner.email.toLowerCase();

  await clearOutbox();

  const recent = fakeChannel();

  recent.users.set(email, "UFOUND");
  await rememberIdentity(email, null, now - DAY + 100);

  const recentEnvelope = await directMessageToOwner(recent.channel, now);

  assert.ok(!recent.lookups.includes(email), "no lookup inside the day");
  assert.ok(!recent.sent.some((item) => item.destination === "UFOUND"));
  assert.equal(
    (await deliveriesFor(recentEnvelope)).find((row) => row.target === owner.id)
      ?.lastError,
    "no_matching_account",
  );

  await clearOutbox();

  const old = fakeChannel();

  old.users.set(email, "UFOUND");
  await rememberIdentity(email, null, now - DAY - 100);
  await directMessageToOwner(old.channel, now);

  assert.ok(old.lookups.includes(email), "looked up again after the day");
  assert.ok(old.sent.some((item) => item.destination === "UFOUND"));
});

test("deliveries claimed after time ran out go back untried, with no attempt counted", async () => {
  const now = Math.floor(Date.now() / 1000);
  const fake = fakeChannel();

  await clearOutbox();

  const envelopeId = await createEnvelope(owner.id, { sentAt: now });

  await recordAuditEvent(
    { actorType: "system", envelopeId, event: "completed" },
    database,
  );
  await expandQueuedEvents(database, depsFor(fake.channel, now));
  await database.query(
    `
      update notification_deliveries
      set next_attempt_at = $2, attempts = 2
      where event_id in (select id from notification_events where envelope_id = $1)
    `,
    [envelopeId, now - 10],
  );

  // Time is left when the batch is claimed and gone when each is tried.
  let checks = 0;

  await deliverDueDeliveries(database, depsFor(fake.channel, now), {
    outOfTime: () => (checks += 1) > 1,
  });

  const rows = await database.query<{
    attempts: number;
    lockedUntil: number | null;
    nextAttemptAt: number;
    status: string;
  }>(
    `
      select d.status, d.attempts, d.locked_until as "lockedUntil",
        d.next_attempt_at as "nextAttemptAt"
      from notification_deliveries d
      join notification_events e on e.id = d.event_id
      where e.envelope_id = $1
    `,
    [envelopeId],
  );

  assert.ok(rows.rows.length > 0);

  for (const row of rows.rows) {
    assert.equal(row.status, "pending");
    assert.equal(row.attempts, 2, "no attempt was counted");
    assert.equal(row.lockedUntil, null, "the lease was given back");
    assert.equal(row.nextAttemptAt, now, "due again right away");
  }

  assert.equal(fake.sent.length, 0);
  assert.equal(fake.lookups.length, 0);
});

test("the next waiting delivery is the earliest one still ahead, within the window", async () => {
  const now = Math.floor(Date.now() / 1000);
  const eventId = randomUUID();

  await clearOutbox();
  await database.query(
    `
      insert into notification_events (
        id, dedupe_key, source, event, envelope_id, created_at, processed_at
      ) values ($1, $1, 'job', 'probe', null, $2, $2)
    `,
    [eventId, now],
  );

  try {
    const waiting: [string, number][] = [
      ["pending", now + 100],
      ["pending", now + 50],
      ["pending", now - 5],
      ["pending", now + 9999],
      ["sent", now + 10],
    ];

    for (const [index, [status, next]] of waiting.entries()) {
      await database.query(
        `
          insert into notification_deliveries (
            id, event_id, channel, target_kind, target, status,
            next_attempt_at, created_at, updated_at
          ) values ($1, $2, 'slack', 'channel', $3, $4, $5, $6, $6)
        `,
        [randomUUID(), eventId, `C0PROBE${index}`, status, next, now],
      );
    }

    assert.equal(await nextDeliveryDueAt(database, now, 1000), now + 50);
    assert.equal(await nextDeliveryDueAt(database, now, 20), null);
  } finally {
    await database.query(`delete from notification_events where id = $1`, [
      eventId,
    ]);
  }
});

test("purging keeps what is still needed and deletes the rest", async () => {
  const now = Math.floor(Date.now() / 1000);
  const old = now - 31 * DAY;
  const sentEnvelope = await createEnvelope(owner.id, { sentAt: now });
  const doneEnvelope = await createEnvelope(owner.id, {
    sentAt: now,
    status: "completed",
  });
  const events = {
    deletable: randomUUID(),
    doneMarker: randomUUID(),
    liveMarker: randomUUID(),
    pending: randomUUID(),
    recent: randomUUID(),
    sending: randomUUID(),
  };
  const insertEvent = (
    id: string,
    source: string,
    envelopeId: string | null,
    processedAt: number,
  ) =>
    database.query(
      `
        insert into notification_events (
          id, dedupe_key, source, event, envelope_id, created_at, processed_at
        ) values ($1, $1, $2, 'probe', $3, $4, $4)
      `,
      [id, source, envelopeId, processedAt],
    );
  const insertDelivery = (eventId: string, status: string) =>
    database.query(
      `
        insert into notification_deliveries (
          id, event_id, channel, target_kind, target, status,
          next_attempt_at, created_at, updated_at
        ) values ($1, $2, 'slack', 'channel', 'C0PURGE', $3, $4, $4, $4)
      `,
      [randomUUID(), eventId, status, now],
    );

  await insertEvent(events.deletable, "audit", sentEnvelope, old);
  await insertEvent(events.pending, "audit", sentEnvelope, old);
  await insertDelivery(events.pending, "pending");
  await insertEvent(events.sending, "audit", sentEnvelope, old);
  await insertDelivery(events.sending, "sending");
  await insertEvent(events.liveMarker, "job", sentEnvelope, old);
  await insertEvent(events.doneMarker, "job", doneEnvelope, old);
  await insertEvent(events.recent, "audit", sentEnvelope, now - 5 * DAY);

  const idle = {
    envelopeId: await createEnvelope(owner.id, { sentAt: now }),
    target: "T0IDLE",
  };
  const leased = {
    envelopeId: await createEnvelope(owner.id, { sentAt: now }),
    target: "T0LEASED",
  };
  const fresh = {
    envelopeId: await createEnvelope(owner.id, { sentAt: now }),
    target: "T0FRESH",
  };
  const insertThread = (
    item: { envelopeId: string; target: string },
    updatedAt: number,
    leaseUntil: number | null,
  ) =>
    database.query(
      `
        insert into notification_threads (
          envelope_id, channel, target_kind, target, lease_until,
          created_at, updated_at
        ) values ($1, 'slack', 'channel', $2, $3, $4, $4)
      `,
      [item.envelopeId, item.target, leaseUntil, updatedAt],
    );

  await insertThread(idle, now - 91 * DAY, null);
  await insertThread(leased, now - 91 * DAY, now + 100);
  await insertThread(fresh, now - DAY, null);

  await purgeOldNotifications(database, now);

  const remaining = await database.query<{ id: string }>(
    `select id from notification_events where id = any($1)`,
    [Object.values(events)],
  );
  const kept = new Set(remaining.rows.map((row) => row.id));

  assert.ok(!kept.has(events.deletable), "an old, finished event is deleted");
  assert.ok(
    !kept.has(events.doneMarker),
    "a job marker for a finished envelope is deleted",
  );
  assert.ok(kept.has(events.pending), "a pending delivery keeps its event");
  assert.ok(kept.has(events.sending), "a sending delivery keeps its event");
  assert.ok(
    kept.has(events.liveMarker),
    "a job marker stays while its envelope is out for signature",
  );
  assert.ok(kept.has(events.recent), "a recently processed event stays");

  const threads = await database.query<{ target: string }>(
    `select target from notification_threads where envelope_id = any($1)`,
    [[idle.envelopeId, leased.envelopeId, fresh.envelopeId]],
  );

  assert.deepEqual(threads.rows.map((row) => row.target).sort(), [
    "T0FRESH",
    "T0LEASED",
  ]);
});
