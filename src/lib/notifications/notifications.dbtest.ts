import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

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
  type OutboxDeps,
} from "./outbox.ts";
import { savePreferenceChoices } from "./preferences.ts";
import { createNotificationRule, NotificationSettingsError } from "./rules.ts";

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
