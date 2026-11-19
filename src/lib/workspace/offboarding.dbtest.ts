import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type pg from "pg";

import { replaceDbPoolForTests } from "../db/connection.ts";
import { openTestDatabase } from "../db/test-database.ts";
import { isSignInBlockedByDirectory } from "./directory-block.ts";
import {
  OFFBOARDING_ADVISORY_LOCK_ID,
  readLastOffboardingRun,
  runOffboarding,
  type OffboardingAccountResult,
  type OffboardingRun,
} from "./offboarding.ts";
import {
  DirectoryError,
  type DirectoryEntry,
  type WorkspaceDirectory,
} from "./types.ts";

// Offboarding against a real Postgres: sign-in blocked and sessions ended,
// open envelopes and drafts handed to the manager or an administrator, the
// last administrator and break-glass accounts left alone, the per-run cap,
// failed lookups, and the audit trail. The directory is a stand-in for any
// provider's. Run with `npm run test:db`.
//
// Each test makes its accounts in a domain of its own, so only they are in
// scope, whatever other tests left in the database.

let database: pg.Pool;
let replaced: pg.Pool | null = null;
const createdUsers: string[] = [];
let administratorsBefore: string[] = [];
// Starts somewhere different on each run, so a database that still holds
// the audit rows of an earlier run of this file does not answer for this one.
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
  return `offboard-${randomUUID().slice(0, 8)}.test`;
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

type Answer = DirectoryEntry | null | Error;

function person(email: string, overrides: Partial<DirectoryEntry> = {}) {
  return {
    archived: false,
    email,
    managerEmail: null,
    name: "",
    suspended: false,
    ...overrides,
  } satisfies DirectoryEntry;
}

function suspended(email: string, managerEmail: string | null = null) {
  return person(email, { managerEmail, suspended: true });
}

/**
 * A stand-in directory that answers from a table, and notes who was asked
 * about. Anyone not in the table is an active member.
 */
function standInDirectory(answers: Record<string, Answer>) {
  const asked: string[] = [];
  const directory: WorkspaceDirectory = {
    getPerson: (email) => {
      const key = email.toLowerCase();

      asked.push(key);

      const answer = answers[key];

      if (answer instanceof Error) {
        return Promise.reject(answer);
      }

      return Promise.resolve(answer === undefined ? person(key) : answer);
    },
    isGroupMember: () => Promise.resolve(false),
    listPersonGroups: () => Promise.resolve([]),
    searchPeople: () => Promise.resolve([]),
  };

  return { asked, directory };
}

async function run(
  domain: string,
  directory: WorkspaceDirectory,
  env: Record<string, string> = {},
): Promise<{ at: number; outcome: OffboardingRun }> {
  const at = tick();
  const outcome = await runOffboarding({
    database,
    directory,
    env: { WORKSPACE_DIRECTORY_DOMAINS: domain, ...env },
    now: () => at,
    provider: "stand-in",
    stored: { "directory.offboarding": "on" },
  });

  assert.equal(outcome.status, "ran");

  return { at, outcome: outcome as OffboardingRun };
}

function resultFor(
  outcome: OffboardingRun,
  userId: string,
): OffboardingAccountResult | undefined {
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

  const { directory } = standInDirectory({
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
  assert.equal(trail[0]!.metadata?.source, "stand-in");

  const toGrace = trail.find((row) => row.metadata?.toUserId === grace.id);

  assert.equal(toGrace?.metadata?.count, 2);
  assert.equal(toGrace?.metadata?.handedTo, "manager");
  assert.deepEqual(
    [...((toGrace?.metadata?.envelopeIds as string[]) ?? [])].sort(),
    [draft, sent].sort(),
  );

  const toAdmin = trail.find((row) => row.metadata?.toUserId === admin.id);

  assert.equal(toAdmin?.metadata?.handedTo, "administrator");
  assert.deepEqual(toAdmin?.metadata?.envelopeIds, [inherited]);

  assert.equal(resultFor(outcome, ada.id)?.action, "offboarded");
  assert.equal(outcome.counts.blocked, 1);
  assert.equal(outcome.counts.envelopesHandedOver, 3);

  // What Settings shows.
  const lastRun = await readLastOffboardingRun(database);

  assert.equal(lastRun?.ranAt, at);
  assert.equal(lastRun?.counts.blocked, 1);
  assert.equal(lastRun?.counts.envelopesHandedOver, 3);
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
  // says they are active. Outside the domain, so this run leaves the block
  // alone.
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
  const { directory } = standInDirectory({
    [reportsToNobody.email]: suspended(
      reportsToNobody.email,
      `nobody@${domain}`,
    ),
    [reportsToBlocked.email]: suspended(reportsToBlocked.email, boss.email),
    [reportsToClosing.email]: suspended(reportsToClosing.email, closing.email),
    // The manager has an account here, but the directory says they left too.
    [reportsToLeaver.email]: suspended(reportsToLeaver.email, leaver.email),
    [leaver.email]: suspended(leaver.email),
  });
  const { at } = await run(domain, directory);

  for (const envelopeId of [fromA, fromB, fromC, fromD]) {
    assert.deepEqual(await envelopeRow(envelopeId), {
      handedOverAt: at,
      userId: admin.id,
    });
  }
});

test("an account the directory no longer has is blocked as deleted", async () => {
  await resetRoles();

  const domain = newDomain();

  await createUser(domain, "admin", "admin");

  const gone = await createUser(domain, "gone");
  const archived = await createUser(domain, "archived");
  const { directory } = standInDirectory({
    [archived.email]: person(archived.email, { archived: true }),
    [gone.email]: null,
  });

  await run(domain, directory);

  assert.equal((await userRow(gone.id)).reason, "directory_deleted");
  assert.equal((await userRow(archived.id)).reason, "directory_archived");
});

test("the last administrator who can sign in is never blocked", async () => {
  await resetRoles();

  const domain = newDomain();
  const admin = await createUser(domain, "onlyadmin", "admin");
  const envelope = await createEnvelope(admin.id, "sent");

  await createSession(admin.id);

  const { directory } = standInDirectory({
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
  // Nor demoted: it is still the administrator.
  const { rows } = await database.query<{ role: string }>(
    `select role from public."user" where id = $1`,
    [admin.id],
  );

  assert.equal(rows[0]?.role, "admin");

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
  const { directory } = standInDirectory({
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
  const oldGlass = await createUser(domain, "oldglass");
  const envelope = await createEnvelope(glass.id, "sent");

  await database.query(
    `update public."user" set directory_blocked_at = 1, directory_blocked_reason = 'directory_deleted' where id = $1`,
    [oldGlass.id],
  );

  const { directory } = standInDirectory({
    [glass.email]: suspended(glass.email),
    [oldGlass.email]: null,
  });
  const { outcome } = await run(domain, directory, {
    PASSWORD_SIGN_IN_ALLOWED_EMAILS: `${glass.email}, ${oldGlass.email}`,
  });

  assert.equal((await userRow(glass.id)).blockedAt, null);
  assert.equal((await envelopeRow(envelope)).userId, glass.id);
  assert.equal(resultFor(outcome, glass.id)?.action, "skipped");
  assert.equal((await userRow(oldGlass.id)).blockedAt, null);
  assert.equal(resultFor(outcome, oldGlass.id)?.action, "restored");
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
  const { directory } = standInDirectory(
    Object.fromEntries(
      leavers.map((user) => [user.email, suspended(user.email)]),
    ),
  );
  const capped = { WORKSPACE_OFFBOARDING_MAX_PER_RUN: "2" };
  const first = await run(domain, directory, capped);

  assert.equal(first.outcome.maxPerRun, 2);
  assert.equal(first.outcome.counts.blocked, 2);
  assert.equal(first.outcome.counts.deferred, 1);

  const deferred = first.outcome.accounts.find(
    (account) => account.action === "deferred",
  )!;

  assert.equal((await userRow(deferred.userId)).blockedAt, null);
  assert.equal((await userRow(deferred.userId)).checkedAt, null);

  const second = await run(domain, directory, capped);

  assert.equal(second.outcome.counts.blocked, 1);
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
  assert.equal(third.outcome.counts.blocked, 0);
  assert.equal(
    (await Promise.all(leavers.map((user) => systemEvents(user.id)))).flat()
      .length,
    eventsBefore,
  );

  // Each block keeps the time it was first made.
  for (const user of leavers) {
    assert.ok(
      [first.at, second.at].includes((await userRow(user.id)).blockedAt ?? 0),
    );
  }
});

test("a reactivated account is unblocked", async () => {
  await resetRoles();

  const domain = newDomain();

  await createUser(domain, "admin", "admin");

  const ada = await createUser(domain, "ada");
  const answers: Record<string, Answer> = {
    [ada.email]: suspended(ada.email),
  };
  const { directory } = standInDirectory(answers);

  await run(domain, directory);
  assert.notEqual((await userRow(ada.id)).blockedAt, null);

  answers[ada.email] = person(ada.email);

  const { outcome } = await run(domain, directory);
  const row = await userRow(ada.id);

  assert.equal(row.blockedAt, null);
  assert.equal(row.reason, null);
  assert.equal(await isSignInBlockedByDirectory(ada.email, database), false);
  assert.equal(resultFor(outcome, ada.id)?.action, "restored");
  assert.equal(outcome.counts.unblocked, 1);

  const trail = await systemEvents(ada.id);

  assert.equal(trail.at(-1)?.event, "directory_sign_in_unblocked");
  assert.equal(trail.at(-1)?.metadata?.previousReason, "directory_suspended");
  assert.equal(trail.at(-1)?.metadata?.why, "directory_active");
});

test("a directory error never blocks anyone, and a failing directory stops the run", async () => {
  await resetRoles();

  const domain = newDomain();

  await createUser(domain, "admin", "admin");

  const failing = await createUser(domain, "failing");
  const unreachable = await createUser(domain, "unreachable");
  const fine1 = await createUser(domain, "fine1");
  const fine2 = await createUser(domain, "fine2");
  const { directory } = standInDirectory({
    [failing.email]: new DirectoryError("The directory answered 500.", 500),
    [unreachable.email]: new DirectoryError(
      "The directory could not be reached.",
      null,
    ),
    [fine1.email]: person(fine1.email),
    [fine2.email]: person(fine2.email),
  });
  const { outcome } = await run(domain, directory);

  assert.equal(outcome.stoppedEarly, false);

  for (const user of [failing, unreachable]) {
    assert.equal((await userRow(user.id)).blockedAt, null);
    // Asked again first next time.
    assert.equal((await userRow(user.id)).checkedAt, null);
    assert.equal(resultFor(outcome, user.id)?.action, "skipped");
  }

  assert.deepEqual(resultFor(outcome, failing.id), {
    action: "skipped",
    email: failing.email,
    error: "The directory answered 500.",
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
  const broken = standInDirectory({
    [`admin@${brokenDomain}`]: new DirectoryError("403", 403),
    [people[0]!.email]: new DirectoryError("403", 403),
    [people[1]!.email]: new DirectoryError("403", 403),
    [people[2]!.email]: null,
    [people[3]!.email]: null,
  });
  const stopped = await run(brokenDomain, broken.directory);

  assert.equal(stopped.outcome.stoppedEarly, true);
  assert.equal(stopped.outcome.counts.blocked, 0);

  for (const someone of people) {
    assert.equal((await userRow(someone.id)).blockedAt, null);
  }

  assert.equal((await readLastOffboardingRun(database))?.stoppedEarly, true);
});

test("a directory error never lifts a block either", async () => {
  await resetRoles();

  const domain = newDomain();

  await createUser(domain, "admin", "admin");
  await createUser(domain, "fine");

  const ada = await createUser(domain, "ada");

  await database.query(
    `update public."user" set directory_blocked_at = 1, directory_blocked_reason = 'directory_suspended' where id = $1`,
    [ada.id],
  );

  const { directory } = standInDirectory({
    [ada.email]: new DirectoryError("The directory answered 503.", 503),
  });

  await run(domain, directory);

  assert.equal((await userRow(ada.id)).blockedAt, 1);
});

test("only accounts in the organization's domains are asked about", async () => {
  await resetRoles();

  const domain = newDomain();
  const elsewhere = newDomain();

  await createUser(domain, "admin", "admin");

  const outsider = await createUser(elsewhere, "outsider");
  const { asked, directory } = standInDirectory({ [outsider.email]: null });

  await run(domain, directory);

  assert.equal(asked.includes(outsider.email), false);
  assert.equal((await userRow(outsider.id)).blockedAt, null);
});

test("two runs never overlap", async () => {
  const domain = newDomain();
  const { directory } = standInDirectory({});
  const holder = await database.connect();

  try {
    await holder.query("begin");
    await holder.query("select pg_advisory_xact_lock($1)", [
      OFFBOARDING_ADVISORY_LOCK_ID,
    ]);

    const outcome = await runOffboarding({
      database,
      directory,
      env: { WORKSPACE_DIRECTORY_DOMAINS: domain },
      stored: { "directory.offboarding": "on" },
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

  await createSession(ada.id);

  // The manager is outside the domain, so they are asked about only as
  // someone's manager, and the directory cannot answer.
  const managerEmail = `grace@${newDomain()}`;
  const { directory } = standInDirectory({
    [ada.email]: suspended(ada.email, managerEmail),
    [managerEmail]: new DirectoryError("The directory answered 503.", 503),
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

test("a blocked administrator's kept records go to an administrator who stays", async () => {
  await resetRoles();

  const domain = newDomain();
  const stays = await createUser(domain, "stays", "admin");
  const leaves = await createUser(domain, "leaves", "admin");
  // A finished record handed over from a closed account.
  const record = await createEnvelope(leaves.id, "completed", 7);
  // Their own finished envelope stays theirs.
  const own = await createEnvelope(leaves.id, "completed");
  const { directory } = standInDirectory({
    [leaves.email]: suspended(leaves.email, stays.email),
  });

  await run(domain, directory);

  assert.deepEqual(await envelopeRow(record), {
    handedOverAt: 7,
    userId: stays.id,
  });
  assert.equal((await envelopeRow(own)).userId, leaves.id);
});
