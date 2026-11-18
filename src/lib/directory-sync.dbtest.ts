import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type pg from "pg";

import { replaceDbPoolForTests } from "./db/connection.ts";
import { openTestDatabase } from "./db/test-database.ts";
import { isSignInBlockedByDirectory } from "./directory-block.ts";
import {
  DIRECTORY_SYNC_ADVISORY_LOCK_ID,
  runDirectorySync,
  type DirectorySyncAccountResult,
  type DirectorySyncOutcome,
  type RunDirectorySyncOptions,
} from "./directory-sync.ts";
import {
  DirectoryError,
  type DirectoryClient,
  type DirectoryUser,
} from "./integrations/google/directory.ts";

// Offboarding from the Workspace directory against a real Postgres: sign-in
// blocked and sessions ended, open envelopes and drafts handed to the
// manager or an administrator, the last administrator and break-glass
// accounts left alone, dry runs that change nothing, the per-run cap, and
// the audit trails. The directory itself is a fake. Run with
// `npm run test:db`.
//
// Each test makes its accounts in a Workspace domain of its own, so only
// they are in scope, whatever other tests left in the database.

let database: pg.Pool;
let replaced: pg.Pool | null = null;
const createdUsers: string[] = [];
let administratorsBefore: string[] = [];
// Starts somewhere different on each run, so a database that still holds the
// audit rows of an earlier run of this file does not answer for this one.
let clock = 2_000_000_000 + Math.floor(Math.random() * 100_000_000) * 100;

before(async () => {
  database = await openTestDatabase();
  replaced = replaceDbPoolForTests(database);

  // Who is "the last administrator" is about every account in the
  // database, so the ones other tests left behind step aside meanwhile.
  const existing = await database.query<{ id: string }>(
    `update public."user" set role = 'user' where role = 'admin' returning id`,
  );

  administratorsBefore = existing.rows.map((row) => row.id);
});

after(async () => {
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.query(
    `update public."user" set role = 'admin' where id = any($1)`,
    [administratorsBefore],
  );

  if (replaced) {
    replaceDbPoolForTests(replaced);
  }

  await database.end();
});

type Person = { email: string; id: string };

function newDomain() {
  return `dirsync-${randomUUID().slice(0, 8)}.test`;
}

/** Each run happens at a time of its own, so its audit rows can be found. */
function tick() {
  clock += 100;
  return clock;
}

async function createUser(
  domain: string,
  local: string,
  role: "admin" | "user" = "user",
): Promise<Person> {
  const id = randomUUID();
  const email = `${local}@${domain}`;

  createdUsers.push(id);
  await database.query(
    `
      insert into public."user" (id, name, email, role, "emailVerified")
      values ($1, $2, $3, $4, true)
    `,
    [id, local, email, role],
  );

  return { email, id };
}

/** Nobody created by this file is an administrator any more. */
async function resetRoles() {
  await database.query(
    `update public."user" set role = 'user' where id = any($1)`,
    [createdUsers],
  );
}

async function createEnvelope(
  userId: string,
  status: "completed" | "draft" | "sent",
  handedOverAt: number | null = null,
) {
  const id = randomUUID();

  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash, sent_at,
        completed_at, handed_over_at
      ) values ($1, $2, 'Lease', $3, $4, 'lease.pdf', 10, 1, $5, $6, $7, $8)
    `,
    [
      id,
      userId,
      status,
      `users/${userId}/envelopes/${id}/original.pdf`,
      "a".repeat(64),
      status === "draft" ? null : 1,
      status === "completed" ? 2 : null,
      handedOverAt,
    ],
  );

  return id;
}

async function createSession(userId: string) {
  await database.query(
    `
      insert into public.session (id, "expiresAt", token, "userId")
      values ($1, now() + interval '1 day', $2, $3)
    `,
    [randomUUID(), randomUUID(), userId],
  );
}

async function sessionCount(userId: string) {
  const result = await database.query<{ count: number }>(
    `select count(*)::int as count from public.session where "userId" = $1`,
    [userId],
  );

  return result.rows[0]!.count;
}

async function userRow(userId: string) {
  const result = await database.query<{
    blockedAt: number | null;
    checkedAt: number | null;
    reason: string | null;
  }>(
    `
      select
        directory_blocked_at as "blockedAt",
        directory_blocked_reason as reason,
        directory_checked_at as "checkedAt"
      from public."user"
      where id = $1
    `,
    [userId],
  );

  return result.rows[0]!;
}

async function envelopeRow(envelopeId: string) {
  const result = await database.query<{
    handedOverAt: number | null;
    userId: string;
  }>(
    `
      select user_id as "userId", handed_over_at as "handedOverAt"
      from envelopes
      where id = $1
    `,
    [envelopeId],
  );

  return result.rows[0]!;
}

async function envelopeEvents(envelopeId: string) {
  const result = await database.query<{
    actorType: string;
    event: string;
    metadata: Record<string, unknown> | null;
  }>(
    `
      select event, actor_type as "actorType", metadata
      from audit_events
      where envelope_id = $1
      order by sequence
    `,
    [envelopeId],
  );

  return result.rows;
}

async function systemEvents(targetUserId: string) {
  const result = await database.query<{
    event: string;
    metadata: Record<string, unknown> | null;
  }>(
    `
      select event, metadata
      from system_audit_events
      where target_user_id = $1
      order by sequence
    `,
    [targetUserId],
  );

  return result.rows;
}

async function runEvents(createdAt: number) {
  const result = await database.query<{
    metadata: Record<string, unknown> | null;
  }>(
    `
      select metadata
      from system_audit_events
      where event = 'directory_sync_run' and created_at = $1
    `,
    [createdAt],
  );

  return result.rows;
}

type Answer = DirectoryUser | null | Error;

/** A directory that answers from a table, and counts who was asked about. */
function fakeDirectory(answers: Record<string, Answer>) {
  const asked: string[] = [];
  const directory: DirectoryClient = {
    getUser: (email) => {
      const key = email.toLowerCase();

      asked.push(key);

      const answer = answers[key];

      if (answer instanceof Error) {
        return Promise.reject(answer);
      }

      // Anyone not in the table is an ordinary active member.
      return Promise.resolve(
        answer === undefined
          ? {
              archived: false,
              email: key,
              managerEmail: null,
              name: "",
              suspended: false,
            }
          : answer,
      );
    },
    isGroupMember: () => Promise.resolve(false),
    listUserGroups: () => Promise.resolve([]),
    searchUsers: () => Promise.resolve([]),
  };

  return { asked, directory };
}

function suspended(email: string, managerEmail: string | null = null) {
  return {
    archived: false,
    email,
    managerEmail,
    name: "",
    suspended: true,
  } satisfies DirectoryUser;
}

function active(email: string, managerEmail: string | null = null) {
  return {
    archived: false,
    email,
    managerEmail,
    name: "",
    suspended: false,
  } satisfies DirectoryUser;
}

async function run(
  domain: string,
  directory: DirectoryClient,
  options: Partial<RunDirectorySyncOptions> & {
    env?: Record<string, string>;
  } = {},
): Promise<{
  at: number;
  outcome: Extract<DirectorySyncOutcome, { status: "ran" }>;
}> {
  const at = tick();
  const outcome = await runDirectorySync({
    database,
    directory,
    signupDomains: [],
    stored: {},
    ...options,
    env: {
      DIRECTORY_SYNC: "on",
      GOOGLE_WORKSPACE_DOMAINS: domain,
      ...options.env,
    },
    now: () => at,
  });

  assert.equal(outcome.status, "ran");

  return {
    at,
    outcome: outcome as Extract<DirectorySyncOutcome, { status: "ran" }>,
  };
}

function resultFor(
  outcome: Extract<DirectorySyncOutcome, { status: "ran" }>,
  userId: string,
): DirectorySyncAccountResult | undefined {
  return outcome.accounts.find((account) => account.userId === userId);
}

test("a suspended account is blocked, signed out, and its open work goes to the manager", async () => {
  await resetRoles();

  const domain = newDomain();
  const admin = await createUser(domain, "admin", "admin");
  const ada = await createUser(domain, "ada");
  const grace = await createUser(domain, "grace");
  const sent = await createEnvelope(ada.id, "sent");
  const draft = await createEnvelope(ada.id, "draft");
  const finished = await createEnvelope(ada.id, "completed");
  // Came to Ada from a closed account: an administrator's to keep.
  const inherited = await createEnvelope(ada.id, "sent", 42);

  await createSession(ada.id);
  await createSession(ada.id);
  await createSession(grace.id);

  const { directory } = fakeDirectory({
    [ada.email]: suspended(ada.email, grace.email),
  });
  const { at, outcome } = await run(domain, directory);

  const block = await userRow(ada.id);

  assert.equal(block.blockedAt, at);
  assert.equal(block.reason, "directory_suspended");
  assert.equal(block.checkedAt, at);
  assert.equal(await sessionCount(ada.id), 0);
  assert.equal(await sessionCount(grace.id), 1);
  assert.equal(await isSignInBlockedByDirectory(ada.email, database), true);
  assert.equal(
    await isSignInBlockedByDirectory(ada.email.toUpperCase(), database),
    true,
  );
  assert.equal(await isSignInBlockedByDirectory(grace.email, database), false);
  assert.equal(
    await isSignInBlockedByDirectory(`nobody@${domain}`, database),
    false,
  );

  // To the manager, as the manager's own: not marked as handed over.
  assert.deepEqual(await envelopeRow(sent), {
    handedOverAt: null,
    userId: grace.id,
  });
  assert.deepEqual(await envelopeRow(draft), {
    handedOverAt: null,
    userId: grace.id,
  });
  // Finished records stay; closing the account deals with those.
  assert.deepEqual(await envelopeRow(finished), {
    handedOverAt: null,
    userId: ada.id,
  });
  // A record handed over before goes to an administrator, keeping its day.
  assert.deepEqual(await envelopeRow(inherited), {
    handedOverAt: 42,
    userId: admin.id,
  });

  const events = await envelopeEvents(sent);

  assert.deepEqual(events.at(-1), {
    actorType: "system",
    event: "handed_over",
    metadata: {
      fromEmail: ada.email,
      fromUserId: ada.id,
      handedTo: "manager",
      reason: "directory_suspended",
      status: "sent",
      toEmail: grace.email,
      toUserId: grace.id,
    },
  });
  assert.equal((await envelopeEvents(draft)).at(-1)?.metadata?.status, "draft");
  assert.equal(
    (await envelopeEvents(inherited)).at(-1)?.metadata?.handedTo,
    "administrator",
  );
  assert.deepEqual(await envelopeEvents(finished), []);

  const trail = await systemEvents(ada.id);

  assert.deepEqual(
    trail.map((row) => row.event),
    [
      "directory_sign_in_blocked",
      "envelopes_handed_over",
      "envelopes_handed_over",
    ],
  );
  assert.equal(trail[0]!.metadata?.sessionsEnded, 2);
  assert.equal(trail[0]!.metadata?.targetEmail, ada.email);

  const toGrace = trail.find((row) => row.metadata?.toUserId === grace.id);

  assert.equal(toGrace?.metadata?.count, 2);
  assert.deepEqual(
    [...((toGrace?.metadata?.envelopeIds as string[]) ?? [])].sort(),
    [draft, sent].sort(),
  );

  const result = resultFor(outcome, ada.id);

  assert.equal(result?.action, "offboarded");
  assert.equal(outcome.counts.offboarded, 1);
  assert.equal(outcome.counts.envelopesHandedOver, 3);
  assert.equal((await runEvents(at)).length, 1);
});

test("with no usable manager, an administrator takes the work, marked as handed over", async () => {
  await resetRoles();

  const domain = newDomain();
  const admin = await createUser(domain, "admin", "admin");
  const reportsToNobody = await createUser(domain, "tonobody");
  const reportsToBlocked = await createUser(domain, "toblocked");
  const reportsToClosing = await createUser(domain, "toclosing");
  const reportsToLeaver = await createUser(domain, "toleaver");
  const fromA = await createEnvelope(reportsToNobody.id, "sent");
  const fromB = await createEnvelope(reportsToBlocked.id, "sent");
  const fromC = await createEnvelope(reportsToClosing.id, "draft");
  const fromD = await createEnvelope(reportsToLeaver.id, "sent");
  // Blocked here, though the directory (asked about them as a manager)
  // says they are active. Outside the domains, so this run leaves the
  // block alone.
  const boss = await createUser(newDomain(), "boss");

  await database.query(
    `update public."user" set directory_blocked_at = 1, directory_blocked_reason = 'directory_suspended' where id = $1`,
    [boss.id],
  );

  const closing = await createUser(domain, "closing");

  await database.query(
    `
      insert into account_closure_requests
        (user_id, requested_at, export_expires_at, purge_after_at, updated_at)
      values ($1, 1, 1, 1, 1)
    `,
    [closing.id],
  );

  const leaver = await createUser(domain, "leaver");

  const { directory } = fakeDirectory({
    [reportsToNobody.email]: suspended(
      reportsToNobody.email,
      `nobody@${domain}`,
    ),
    [reportsToBlocked.email]: suspended(reportsToBlocked.email, boss.email),
    [reportsToClosing.email]: suspended(reportsToClosing.email, closing.email),
    // Manager has an account here, but the directory says they left too.
    [reportsToLeaver.email]: suspended(reportsToLeaver.email, leaver.email),
    [leaver.email]: suspended(leaver.email),
  });
  const { at } = await run(domain, directory);

  for (const envelopeId of [fromA, fromB, fromC, fromD]) {
    assert.deepEqual(await envelopeRow(envelopeId), {
      handedOverAt: at,
      userId: admin.id,
    });
    assert.equal(
      (await envelopeEvents(envelopeId)).at(-1)?.metadata?.toUserId,
      admin.id,
    );
  }
});

test("an account the directory no longer has is blocked as deleted", async () => {
  await resetRoles();

  const domain = newDomain();

  await createUser(domain, "admin", "admin");

  const gone = await createUser(domain, "gone");
  const { directory } = fakeDirectory({ [gone.email]: null });

  await run(domain, directory);

  assert.equal((await userRow(gone.id)).reason, "directory_deleted");
});

test("the last administrator who can sign in is left alone", async () => {
  await resetRoles();

  const domain = newDomain();
  const admin = await createUser(domain, "onlyadmin", "admin");
  const envelope = await createEnvelope(admin.id, "sent");

  await createSession(admin.id);

  const { directory } = fakeDirectory({
    [admin.email]: suspended(admin.email),
  });
  const { outcome } = await run(domain, directory);

  assert.equal((await userRow(admin.id)).blockedAt, null);
  assert.equal(await sessionCount(admin.id), 1);
  assert.equal((await envelopeRow(envelope)).userId, admin.id);
  assert.deepEqual(resultFor(outcome, admin.id), {
    action: "skipped",
    email: admin.email,
    reason: "directory_suspended",
    userId: admin.id,
    why: "last_admin",
  });

  // Once someone else can sign in as an administrator, it goes ahead.
  await createUser(domain, "newadmin", "admin");
  await run(domain, directory);

  assert.notEqual((await userRow(admin.id)).blockedAt, null);
});

test("of two suspended administrators, one is kept", async () => {
  await resetRoles();

  const domain = newDomain();
  const first = await createUser(domain, "first", "admin");
  const second = await createUser(domain, "second", "admin");
  const { directory } = fakeDirectory({
    [first.email]: suspended(first.email),
    [second.email]: suspended(second.email),
  });

  await run(domain, directory);

  const blocked = [
    (await userRow(first.id)).blockedAt,
    (await userRow(second.id)).blockedAt,
  ].filter((value) => value !== null);

  assert.equal(blocked.length, 1);
});

test("a break-glass address is never blocked, and an old block on one is lifted", async () => {
  await resetRoles();

  const domain = newDomain();

  await createUser(domain, "admin", "admin");

  const glass = await createUser(domain, "glass");
  const storedGlass = await createUser(domain, "storedglass");
  const envelope = await createEnvelope(glass.id, "sent");

  await database.query(
    `update public."user" set directory_blocked_at = 1, directory_blocked_reason = 'directory_deleted' where id = $1`,
    [storedGlass.id],
  );

  const { directory } = fakeDirectory({
    [glass.email]: suspended(glass.email),
    [storedGlass.email]: null,
  });
  const { outcome } = await run(domain, directory, {
    env: { PASSWORD_SIGN_IN_ALLOWED_EMAILS: glass.email },
    stored: { "sso.passwordAllowedEmails": storedGlass.email },
  });

  assert.equal((await userRow(glass.id)).blockedAt, null);
  assert.equal((await envelopeRow(envelope)).userId, glass.id);
  assert.equal(resultFor(outcome, glass.id)?.action, "skipped");
  assert.equal((await userRow(storedGlass.id)).blockedAt, null);
  assert.equal(resultFor(outcome, storedGlass.id)?.action, "restored");
});

test("a dry run reports what it would do and changes nothing", async () => {
  await resetRoles();

  const domain = newDomain();

  await createUser(domain, "admin", "admin");

  const ada = await createUser(domain, "ada");
  const grace = await createUser(domain, "grace");
  const sent = await createEnvelope(ada.id, "sent");

  await createSession(ada.id);

  const { directory } = fakeDirectory({
    [ada.email]: suspended(ada.email, grace.email),
  });
  const { at, outcome } = await run(domain, directory, { dryRun: true });

  assert.equal(outcome.dryRun, true);
  assert.deepEqual(resultFor(outcome, ada.id), {
    action: "offboarded",
    blocked: true,
    email: ada.email,
    envelopes: [
      {
        envelopeId: sent,
        handedTo: "manager",
        status: "sent",
        toEmail: grace.email,
        toUserId: grace.id,
      },
    ],
    envelopesKept: 0,
    reason: "directory_suspended",
    sessionsEnded: 1,
    userId: ada.id,
  });

  assert.deepEqual(await userRow(ada.id), {
    blockedAt: null,
    checkedAt: null,
    reason: null,
  });
  assert.equal(await sessionCount(ada.id), 1);
  assert.equal((await envelopeRow(sent)).userId, ada.id);
  assert.deepEqual(await envelopeEvents(sent), []);
  assert.deepEqual(await systemEvents(ada.id), []);

  const runRows = await runEvents(at);

  assert.equal(runRows.length, 1);
  assert.equal(runRows[0]!.metadata?.dryRun, true);
  assert.equal(runRows[0]!.metadata?.offboarded, 1);
});

test("a dry run counts the administrators it would already have blocked", async () => {
  await resetRoles();

  const domain = newDomain();
  const first = await createUser(domain, "first", "admin");
  const second = await createUser(domain, "second", "admin");
  const { directory } = fakeDirectory({
    [first.email]: suspended(first.email),
    [second.email]: suspended(second.email),
  });
  const { outcome } = await run(domain, directory, { dryRun: true });

  assert.deepEqual(outcome.accounts.map((account) => account.action).sort(), [
    "offboarded",
    "skipped",
  ]);
});

test("past the per-run cap, accounts wait for the next run, and re-runs change nothing more", async () => {
  await resetRoles();

  const domain = newDomain();

  await createUser(domain, "admin", "admin");

  const leavers = [
    await createUser(domain, "one"),
    await createUser(domain, "two"),
    await createUser(domain, "three"),
  ];
  const { directory } = fakeDirectory(
    Object.fromEntries(
      leavers.map((user) => [user.email, suspended(user.email)]),
    ),
  );

  const first = await run(domain, directory, {
    env: { DIRECTORY_SYNC_MAX_PER_RUN: "5" },
    limit: 2,
  });

  assert.equal(first.outcome.maxPerRun, 2);
  assert.equal(first.outcome.counts.offboarded, 2);
  assert.equal(first.outcome.counts.deferred, 1);

  const deferred = first.outcome.accounts.find(
    (account) => account.action === "deferred",
  )!;

  assert.equal((await userRow(deferred.userId)).blockedAt, null);
  assert.equal((await userRow(deferred.userId)).checkedAt, null);

  const second = await run(domain, directory, { limit: 2 });

  assert.equal(second.outcome.counts.offboarded, 1);
  assert.equal(
    resultFor(second.outcome, deferred.userId)?.action,
    "offboarded",
  );

  for (const user of leavers) {
    assert.notEqual((await userRow(user.id)).blockedAt, null);
  }

  const eventsBefore = (
    await Promise.all(leavers.map((user) => systemEvents(user.id)))
  ).flat().length;
  const third = await run(domain, directory);

  assert.deepEqual(third.outcome.accounts, []);
  assert.equal(third.outcome.counts.offboarded, 0);
  assert.equal(
    (await Promise.all(leavers.map((user) => systemEvents(user.id)))).flat()
      .length,
    eventsBefore,
  );
  // A run with nothing to do leaves no line in the trail.
  assert.deepEqual(await runEvents(third.at), []);
  // Each block keeps the time it was first made.
  for (const user of leavers) {
    assert.ok(
      [first.at, second.at].includes((await userRow(user.id)).blockedAt ?? 0),
    );
  }
});

test("the block is lifted when the directory says the account is active again", async () => {
  await resetRoles();

  const domain = newDomain();

  await createUser(domain, "admin", "admin");

  const ada = await createUser(domain, "ada");
  const answers: Record<string, Answer> = { [ada.email]: suspended(ada.email) };
  const { directory } = fakeDirectory(answers);

  await run(domain, directory);
  assert.notEqual((await userRow(ada.id)).blockedAt, null);

  answers[ada.email] = active(ada.email);

  const { outcome } = await run(domain, directory);

  const row = await userRow(ada.id);

  assert.equal(row.blockedAt, null);
  assert.equal(row.reason, null);
  assert.equal(await isSignInBlockedByDirectory(ada.email, database), false);
  assert.equal(resultFor(outcome, ada.id)?.action, "restored");

  const trail = await systemEvents(ada.id);

  assert.equal(trail.at(-1)?.event, "directory_sign_in_restored");
  assert.equal(trail.at(-1)?.metadata?.previousReason, "directory_suspended");
  assert.equal(trail.at(-1)?.metadata?.why, "directory_active");
});

test("a lookup that fails blocks nobody, and a failing directory stops the run", async () => {
  await resetRoles();

  const domain = newDomain();

  await createUser(domain, "admin", "admin");

  const failing = await createUser(domain, "failing");
  const fine = await createUser(domain, "fine");
  const { directory } = fakeDirectory({
    [failing.email]: new DirectoryError("Google answered with 500.", 500),
    [fine.email]: active(fine.email),
  });
  const { outcome } = await run(domain, directory);

  assert.equal(outcome.stoppedEarly, false);
  assert.equal((await userRow(failing.id)).blockedAt, null);
  assert.equal((await userRow(failing.id)).checkedAt, null);
  assert.deepEqual(resultFor(outcome, failing.id), {
    action: "skipped",
    email: failing.email,
    error: "Google answered with 500.",
    userId: failing.id,
    why: "lookup_failed",
  });

  // Most lookups failing: even the ones that answered "gone" are not acted on.
  const brokenDomain = newDomain();

  await createUser(brokenDomain, "admin", "admin");

  const people = [
    await createUser(brokenDomain, "p1"),
    await createUser(brokenDomain, "p2"),
    await createUser(brokenDomain, "p3"),
    await createUser(brokenDomain, "p4"),
  ];
  const broken = fakeDirectory({
    [`admin@${brokenDomain}`]: new DirectoryError("403", 403),
    [people[0]!.email]: new DirectoryError("403", 403),
    [people[1]!.email]: new DirectoryError("403", 403),
    [people[2]!.email]: null,
    [people[3]!.email]: null,
  });
  const stopped = await run(brokenDomain, broken.directory);

  assert.equal(stopped.outcome.stoppedEarly, true);
  assert.equal(stopped.outcome.counts.offboarded, 0);

  for (const person of people) {
    assert.equal((await userRow(person.id)).blockedAt, null);
  }

  assert.equal((await runEvents(stopped.at))[0]?.metadata?.stoppedEarly, true);
});

test("only accounts in the Workspace domains are asked about", async () => {
  await resetRoles();

  const domain = newDomain();
  const elsewhere = newDomain();

  await createUser(domain, "admin", "admin");

  const outsider = await createUser(elsewhere, "outsider");
  const { asked, directory } = fakeDirectory({ [outsider.email]: null });

  await run(domain, directory);

  assert.equal(asked.includes(outsider.email), false);
  assert.equal((await userRow(outsider.id)).blockedAt, null);
});

test("two runs never overlap", async () => {
  const domain = newDomain();
  const { directory } = fakeDirectory({});
  const holder = await database.connect();

  try {
    await holder.query("begin");
    await holder.query("select pg_advisory_xact_lock($1)", [
      DIRECTORY_SYNC_ADVISORY_LOCK_ID,
    ]);

    const outcome = await runDirectorySync({
      database,
      directory,
      env: { DIRECTORY_SYNC: "on", GOOGLE_WORKSPACE_DOMAINS: domain },
      signupDomains: [],
      stored: {},
    });

    assert.deepEqual(outcome, { status: "already_running" });
  } finally {
    await holder.query("rollback");
    holder.release();
  }
});

test("a manager whose standing could not be looked up is not taken as gone", async () => {
  await resetRoles();

  const domain = newDomain();

  await createUser(domain, "admin", "admin");

  const ada = await createUser(domain, "ada");
  const sent = await createEnvelope(ada.id, "sent");
  // The manager is outside the Workspace domains, so they are asked about
  // only as someone's manager, and the directory cannot answer.
  await createSession(ada.id);
  const managerEmail = `grace@${newDomain()}`;
  const { directory } = fakeDirectory({
    [ada.email]: suspended(ada.email, managerEmail),
    [managerEmail]: new DirectoryError(
      "Google's directory did not answer.",
      503,
    ),
  });
  const { at, outcome } = await run(domain, directory);
  const result = resultFor(outcome, ada.id);

  assert.equal(result?.action, "offboarded");
  assert.equal(result?.action === "offboarded" ? result.blocked : null, true);
  assert.equal(
    result?.action === "offboarded" ? result.envelopesKept : null,
    1,
  );
  assert.equal(outcome.counts.lookupFailures, 1);
  // Access ends at once; only the hand-over waits for the manager.
  assert.equal((await userRow(ada.id)).blockedAt, at);
  assert.equal(await sessionCount(ada.id), 0);
  assert.deepEqual(await envelopeRow(sent), {
    handedOverAt: null,
    userId: ada.id,
  });
  // Asked again first next time.
  assert.equal((await userRow(ada.id)).checkedAt, null);
});

test("an already blocked account whose open work nobody could take is still reported", async () => {
  await resetRoles();

  const domain = newDomain();
  const ada = await createUser(domain, "ada");

  await createEnvelope(ada.id, "sent");
  await database.query(
    `
      update public."user"
      set directory_blocked_at = 1, directory_blocked_reason = 'directory_suspended'
      where id = $1
    `,
    [ada.id],
  );

  const { directory } = fakeDirectory({
    [ada.email]: suspended(ada.email),
  });
  const { outcome } = await run(domain, directory);
  const result = resultFor(outcome, ada.id);

  assert.equal(result?.action, "offboarded");
  assert.equal(
    result?.action === "offboarded" ? result.envelopesKept : null,
    1,
  );
  assert.equal(outcome.counts.offboarded, 1);
});

test("an already blocked account whose work stays unhanded does not use up a per-run slot", async () => {
  await resetRoles();

  const domain = newDomain();
  const ada = await createUser(domain, "ada");
  const bea = await createUser(domain, "bea");

  await createUser(domain, "admin", "admin");
  await createEnvelope(ada.id, "sent");
  await database.query(
    `
      update public."user"
      set directory_blocked_at = 1, directory_blocked_reason = 'directory_suspended'
      where id = $1
    `,
    [ada.id],
  );
  // Ada was never asked about, so she comes first, ahead of Bea.
  await database.query(
    `update public."user" set directory_checked_at = 1 where id = $1`,
    [bea.id],
  );

  // Ada's manager cannot be looked up, so her work stays where it is.
  const managerEmail = `grace@${newDomain()}`;
  const { directory } = fakeDirectory({
    [ada.email]: suspended(ada.email, managerEmail),
    [bea.email]: suspended(bea.email),
    [managerEmail]: new DirectoryError(
      "Google's directory did not answer.",
      503,
    ),
  });
  const { outcome } = await run(domain, directory, { limit: 1 });

  assert.equal(resultFor(outcome, bea.id)?.action, "offboarded");
  assert.notEqual((await userRow(bea.id)).blockedAt, null);
  assert.equal(outcome.counts.deferred, 0);
});
