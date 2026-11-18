import assert from "node:assert/strict";
import { test } from "node:test";

import {
  collectBreakGlassAddresses,
  DEFAULT_MAX_PER_RUN,
  directoryLooksBroken,
  isWorkspaceAddress,
  lookUpStanding,
  MAX_PER_RUN_LIMIT,
  parseDirectorySyncRequest,
  planAccount,
  readDirectoryStanding,
  readDirectorySyncSetting,
  resolveMaxPerRun,
  runDirectorySync,
  type DirectoryStanding,
  type SyncAccount,
} from "./directory-sync.ts";
import {
  DirectoryError,
  type DirectoryClient,
  type DirectoryUser,
} from "./integrations/google/directory.ts";

// The decisions of the directory sync, without a database. Blocking,
// handing over and the run itself are checked against a real Postgres in
// directory-sync.dbtest.ts.

function entry(overrides: Partial<DirectoryUser> = {}): DirectoryUser {
  return {
    archived: false,
    email: "ada@acme.test",
    managerEmail: "grace@acme.test",
    name: "Ada",
    suspended: false,
    ...overrides,
  };
}

function account(overrides: Partial<SyncAccount> = {}): SyncAccount {
  return {
    blockedAt: null,
    email: "ada@acme.test",
    id: "user-ada",
    name: "Ada",
    openEnvelopes: 0,
    role: "user",
    ...overrides,
  };
}

const ACTIVE: DirectoryStanding = { managerEmail: null, state: "active" };
const SUSPENDED: DirectoryStanding = {
  managerEmail: "grace@acme.test",
  reason: "directory_suspended",
  state: "offboarded",
};
const UNKNOWN: DirectoryStanding = { error: "403", state: "unknown" };

function fakeDirectory(getUser: DirectoryClient["getUser"]): DirectoryClient {
  return {
    getUser,
    isGroupMember: () => Promise.resolve(false),
    listUserGroups: () => Promise.resolve([]),
    searchUsers: () => Promise.resolve([]),
  };
}

test("the directory's answer: archived, suspended, gone or active", () => {
  assert.deepEqual(readDirectoryStanding(entry()), {
    managerEmail: "grace@acme.test",
    state: "active",
  });
  assert.deepEqual(readDirectoryStanding(entry({ suspended: true })), {
    managerEmail: "grace@acme.test",
    reason: "directory_suspended",
    state: "offboarded",
  });
  // Google archives a suspended account too; archived is the one to say.
  assert.equal(
    (
      readDirectoryStanding(entry({ archived: true, suspended: true })) as {
        reason: string;
      }
    ).reason,
    "directory_archived",
  );
  assert.deepEqual(readDirectoryStanding(null), {
    managerEmail: null,
    reason: "directory_deleted",
    state: "offboarded",
  });
});

test("a lookup that fails is unknown, never gone", async () => {
  const failing = fakeDirectory(() =>
    Promise.reject(new DirectoryError("Google did not allow it (403).", 403)),
  );
  const broken = fakeDirectory(() => Promise.reject(new Error("boom")));

  assert.deepEqual(await lookUpStanding(failing, "ada@acme.test"), {
    error: "Google did not allow it (403).",
    state: "unknown",
  });
  assert.equal(
    (await lookUpStanding(broken, "ada@acme.test")).state,
    "unknown",
  );
  assert.equal(
    (
      await lookUpStanding(
        fakeDirectory(() => Promise.resolve(null)),
        "ada@acme.test",
      )
    ).state,
    "offboarded",
  );
});

test("it is off unless turned on, and the environment wins", () => {
  assert.deepEqual(readDirectorySyncSetting({}, {}), {
    enabled: false,
    source: "default",
  });
  assert.deepEqual(
    readDirectorySyncSetting({}, { "people.directorySync": "on" }),
    { enabled: true, source: "settings" },
  );
  assert.deepEqual(readDirectorySyncSetting({ DIRECTORY_SYNC: "on" }, {}), {
    enabled: true,
    source: "env",
  });
  assert.deepEqual(
    readDirectorySyncSetting(
      { DIRECTORY_SYNC: "off" },
      { "people.directorySync": "on" },
    ),
    { enabled: false, source: "env" },
  );
  assert.equal(
    readDirectorySyncSetting({ DIRECTORY_SYNC: "yes" }, {}).enabled,
    false,
  );
});

test("the per-run cap: 10, set between 1 and 500, and a caller can only lower it", () => {
  assert.equal(resolveMaxPerRun({}), DEFAULT_MAX_PER_RUN);
  assert.equal(resolveMaxPerRun({ DIRECTORY_SYNC_MAX_PER_RUN: "25" }), 25);
  assert.equal(
    resolveMaxPerRun({ DIRECTORY_SYNC_MAX_PER_RUN: "100000" }),
    MAX_PER_RUN_LIMIT,
  );
  assert.equal(resolveMaxPerRun({ DIRECTORY_SYNC_MAX_PER_RUN: "0" }), 1);
  assert.equal(
    resolveMaxPerRun({ DIRECTORY_SYNC_MAX_PER_RUN: "lots" }),
    DEFAULT_MAX_PER_RUN,
  );
  assert.equal(
    resolveMaxPerRun({ DIRECTORY_SYNC_MAX_PER_RUN: "-5" }),
    DEFAULT_MAX_PER_RUN,
  );
  assert.equal(resolveMaxPerRun({}, 3), 3);
  assert.equal(resolveMaxPerRun({}, 50), DEFAULT_MAX_PER_RUN);
  assert.equal(resolveMaxPerRun({}, 0), DEFAULT_MAX_PER_RUN);
  assert.equal(resolveMaxPerRun({}, 2.5), DEFAULT_MAX_PER_RUN);
});

test("a dry run and a limit, from the query string or the body", () => {
  const parse = (query: string, body?: unknown) =>
    parseDirectorySyncRequest(new URLSearchParams(query), body);

  assert.deepEqual(parse(""), {
    ok: true,
    request: { dryRun: false, limit: null },
  });
  assert.deepEqual(parse("dryRun=1"), {
    ok: true,
    request: { dryRun: true, limit: null },
  });
  assert.deepEqual(parse("dryRun=true&limit=3"), {
    ok: true,
    request: { dryRun: true, limit: 3 },
  });
  assert.deepEqual(parse("", { dryRun: true, limit: 4 }), {
    ok: true,
    request: { dryRun: true, limit: 4 },
  });
  // Asked for in either place, it is a dry run; the lower limit holds.
  assert.deepEqual(parse("dryRun=0&limit=2", { dryRun: true, limit: 4 }), {
    ok: true,
    request: { dryRun: true, limit: 2 },
  });
  assert.equal(parse("limit=0").ok, false);
  assert.equal(parse("limit=two").ok, false);
  assert.equal(parse("", { dryRun: "yes" }).ok, false);
  assert.equal(parse("", { surprise: true }).ok, false);
  assert.equal(parse("", ["dryRun"]).ok, false);
});

test("only addresses in the Workspace domains are in scope", () => {
  const domains = ["acme.test", "acme.example"];

  assert.equal(isWorkspaceAddress("ada@acme.test", domains), true);
  assert.equal(isWorkspaceAddress("Ada@ACME.example", domains), true);
  assert.equal(isWorkspaceAddress("ada@sub.acme.test", domains), false);
  assert.equal(isWorkspaceAddress("ada@elsewhere.test", domains), false);
  assert.equal(isWorkspaceAddress("ada@acme.test", []), false);
  assert.equal(isWorkspaceAddress("not-an-address", domains), false);
});

test("break-glass addresses come from both lists, whether or not passwords are off", () => {
  const addresses = collectBreakGlassAddresses(
    { PASSWORD_SIGN_IN_ALLOWED_EMAILS: "Root@acme.test, ops@acme.test" },
    { "sso.passwordAllowedEmails": "keeper@acme.test" },
  );

  assert.deepEqual([...addresses].sort(), [
    "keeper@acme.test",
    "ops@acme.test",
    "root@acme.test",
  ]);
  assert.equal(collectBreakGlassAddresses({}, {}).size, 0);
});

test("more than half of the lookups failing means the directory is not working", () => {
  assert.equal(directoryLooksBroken(0, 0), false);
  assert.equal(directoryLooksBroken(5, 2), false);
  assert.equal(directoryLooksBroken(4, 2), false);
  assert.equal(directoryLooksBroken(5, 3), true);
  assert.equal(directoryLooksBroken(1, 1), true);
});

test("planning: offboard, restore, leave alone or skip", () => {
  const none = new Set<string>();

  assert.deepEqual(planAccount(account(), ACTIVE, none), { kind: "nothing" });
  assert.deepEqual(planAccount(account(), SUSPENDED, none), {
    kind: "offboard",
    managerEmail: "grace@acme.test",
    reason: "directory_suspended",
  });
  assert.deepEqual(planAccount(account({ blockedAt: 100 }), ACTIVE, none), {
    kind: "restore",
    why: "directory_active",
  });
  // Blocked on an earlier run with nothing left: nothing to do again.
  assert.deepEqual(planAccount(account({ blockedAt: 100 }), SUSPENDED, none), {
    kind: "nothing",
  });
  // Blocked, but something is still open: it is handed over now.
  assert.equal(
    planAccount(account({ blockedAt: 100, openEnvelopes: 2 }), SUSPENDED, none)
      .kind,
    "offboard",
  );
  assert.deepEqual(planAccount(account(), UNKNOWN, none), {
    error: "403",
    kind: "skip",
    why: "lookup_failed",
  });
  assert.deepEqual(planAccount(account({ blockedAt: 100 }), UNKNOWN, none), {
    error: "403",
    kind: "skip",
    why: "lookup_failed",
  });
});

test("planning: a break-glass address is never offboarded", () => {
  const breakGlass = new Set(["ada@acme.test"]);

  assert.deepEqual(
    planAccount(account({ email: "ADA@acme.test" }), SUSPENDED, breakGlass),
    { kind: "skip", why: "break_glass" },
  );
  assert.deepEqual(planAccount(account(), ACTIVE, breakGlass), {
    kind: "nothing",
  });
  assert.deepEqual(planAccount(account(), UNKNOWN, breakGlass), {
    kind: "nothing",
  });
  // A block from before the address was set aside is lifted.
  assert.deepEqual(
    planAccount(account({ blockedAt: 100 }), SUSPENDED, breakGlass),
    { kind: "restore", why: "break_glass" },
  );
});

test("a run that is not set up says so before it touches anything", async () => {
  let asked = 0;
  const directory = fakeDirectory(() => {
    asked += 1;
    return Promise.resolve(null);
  });

  assert.deepEqual(await runDirectorySync({ directory, env: {}, stored: {} }), {
    reason: "off",
    status: "not_configured",
  });
  assert.deepEqual(
    await runDirectorySync({
      directory: null,
      env: { DIRECTORY_SYNC: "on" },
      stored: {},
    }),
    { reason: "no_directory", status: "not_configured" },
  );
  // On, with a directory, but no Workspace domains: nobody is in scope.
  assert.deepEqual(
    await runDirectorySync({
      directory,
      env: { DIRECTORY_SYNC: "on" },
      signupDomains: [],
      stored: {},
    }),
    { status: "no_domains" },
  );
  assert.equal(asked, 0);
});
