import assert from "node:assert/strict";
import { test } from "node:test";

import {
  collectBreakGlassAddresses,
  DEFAULT_MAX_PER_RUN,
  directoryLooksBroken,
  isOffboardingEnabled,
  isOrganizationAddress,
  lookUpStanding,
  MAX_PER_RUN_LIMIT,
  offboardingHttpStatus,
  parseDomainList,
  planAccount,
  readDirectoryStanding,
  resolveMaxPerRun,
  resolveOrganizationDomains,
  runOffboarding,
  type DirectoryStanding,
  type OffboardingRun,
  type SyncAccount,
} from "./offboarding.ts";
import {
  DirectoryError,
  type DirectoryEntry,
  type WorkspaceDirectory,
} from "./types.ts";

// The decisions of offboarding, without a database. Blocking, handing over
// and the run itself are checked against a real Postgres in
// offboarding.dbtest.ts.

function entry(overrides: Partial<DirectoryEntry> = {}): DirectoryEntry {
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

/** A stand-in for any provider's directory. */
function standInDirectory(
  getPerson: WorkspaceDirectory["getPerson"],
): WorkspaceDirectory {
  return {
    getPerson,
    isGroupMember: () => Promise.resolve(false),
    listPersonGroups: () => Promise.resolve([]),
    searchPeople: () => Promise.resolve([]),
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
  // A provider may report an archived account as suspended too; archived
  // is the one to say.
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

test("a directory error is unknown, never gone", async () => {
  const failing = standInDirectory(() =>
    Promise.reject(new DirectoryError("The directory answered 403.", 403)),
  );
  const unreachable = standInDirectory(() =>
    Promise.reject(
      new DirectoryError("The directory could not be reached.", null),
    ),
  );
  const broken = standInDirectory(() =>
    Promise.reject(new Error("boom: secret@acme.test")),
  );

  assert.deepEqual(await lookUpStanding(failing, "ada@acme.test"), {
    error: "The directory answered 403.",
    state: "unknown",
  });
  assert.equal(
    (await lookUpStanding(unreachable, "ada@acme.test")).state,
    "unknown",
  );
  // Another error's message is not repeated: it could echo what was sent.
  assert.deepEqual(await lookUpStanding(broken, "ada@acme.test"), {
    error: "The directory could not be asked.",
    state: "unknown",
  });
  assert.equal(
    (
      await lookUpStanding(
        standInDirectory(() => Promise.resolve(null)),
        "ada@acme.test",
      )
    ).state,
    "offboarded",
  );
});

test("it is off unless turned on, and the environment wins", () => {
  assert.equal(isOffboardingEnabled({}, {}), false);
  assert.equal(
    isOffboardingEnabled({ "directory.offboarding": "on" }, {}),
    true,
  );
  assert.equal(isOffboardingEnabled({}, { WORKSPACE_OFFBOARDING: "on" }), true);
  assert.equal(
    isOffboardingEnabled(
      { "directory.offboarding": "on" },
      { WORKSPACE_OFFBOARDING: "off" },
    ),
    false,
  );
  assert.equal(
    isOffboardingEnabled({}, { WORKSPACE_OFFBOARDING: "yes" }),
    false,
  );
});

test("the organization's domains: the setting, or else the sign-up rule's", () => {
  assert.deepEqual(parseDomainList("Acme.test, @acme.example;acme.test"), [
    "acme.test",
    "acme.example",
  ]);
  assert.equal(parseDomainList("acme.test, not a domain"), null);
  assert.deepEqual(
    resolveOrganizationDomains({ "directory.domains": "acme.test" }, {}, [
      "signup.test",
    ]),
    ["acme.test"],
  );
  assert.deepEqual(
    resolveOrganizationDomains(
      { "directory.domains": "acme.test" },
      { WORKSPACE_DIRECTORY_DOMAINS: "env.test" },
    ),
    ["env.test"],
  );
  assert.deepEqual(resolveOrganizationDomains({}, {}, ["Signup.test"]), [
    "signup.test",
  ]);
  assert.deepEqual(resolveOrganizationDomains({}, {}, []), []);
  // A broken value checks nobody rather than guessing.
  assert.deepEqual(
    resolveOrganizationDomains({}, { WORKSPACE_DIRECTORY_DOMAINS: "a b c" }),
    [],
  );
});

test("only addresses in the organization's domains are in scope", () => {
  const domains = ["acme.test", "acme.example"];

  assert.equal(isOrganizationAddress("ada@acme.test", domains), true);
  assert.equal(isOrganizationAddress("Ada@ACME.example", domains), true);
  assert.equal(isOrganizationAddress("ada@sub.acme.test", domains), false);
  assert.equal(isOrganizationAddress("ada@elsewhere.test", domains), false);
  assert.equal(isOrganizationAddress("ada@acme.test", []), false);
  assert.equal(isOrganizationAddress("not-an-address", domains), false);
});

test("the per-run cap: 10, or set between 1 and 500", () => {
  assert.equal(resolveMaxPerRun({}), DEFAULT_MAX_PER_RUN);
  assert.equal(
    resolveMaxPerRun({ WORKSPACE_OFFBOARDING_MAX_PER_RUN: "25" }),
    25,
  );
  assert.equal(
    resolveMaxPerRun({ WORKSPACE_OFFBOARDING_MAX_PER_RUN: "100000" }),
    MAX_PER_RUN_LIMIT,
  );
  assert.equal(resolveMaxPerRun({ WORKSPACE_OFFBOARDING_MAX_PER_RUN: "0" }), 1);
  assert.equal(
    resolveMaxPerRun({ WORKSPACE_OFFBOARDING_MAX_PER_RUN: "lots" }),
    DEFAULT_MAX_PER_RUN,
  );
  assert.equal(
    resolveMaxPerRun({ WORKSPACE_OFFBOARDING_MAX_PER_RUN: "-5" }),
    DEFAULT_MAX_PER_RUN,
  );
});

test("break-glass addresses count whether or not passwords are off", () => {
  const addresses = collectBreakGlassAddresses({
    PASSWORD_SIGN_IN_ALLOWED_EMAILS: "Root@acme.test, ops@acme.test",
  });

  assert.deepEqual([...addresses].sort(), ["ops@acme.test", "root@acme.test"]);
  assert.equal(collectBreakGlassAddresses({}).size, 0);
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
  // Active again: the block is lifted.
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
  // A failed lookup neither blocks nor lifts a block.
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

test("a run that is not set up says so before it asks anyone", async () => {
  let asked = 0;
  const directory = standInDirectory(() => {
    asked += 1;
    return Promise.resolve(null);
  });
  const on = { "directory.offboarding": "on" } as const;

  assert.deepEqual(await runOffboarding({ directory, env: {}, stored: {} }), {
    reason: "off",
    status: "not_configured",
  });
  assert.deepEqual(
    await runOffboarding({ directory: null, env: {}, stored: on }),
    { reason: "no_directory", status: "not_configured" },
  );
  // On, with a directory, but no domains: nobody is in scope.
  assert.deepEqual(
    await runOffboarding({ directory, env: {}, signupDomains: [], stored: on }),
    { status: "no_domains" },
  );
  assert.equal(asked, 0);
});

test("the scheduler's status says whether a run that could not go ahead or stopped early failed", () => {
  const ran: OffboardingRun = {
    accounts: [],
    counts: {
      blocked: 0,
      checked: 0,
      deferred: 0,
      envelopesHandedOver: 0,
      lookupFailures: 0,
      skipped: 0,
      unblocked: 0,
    },
    maxPerRun: 10,
    moreToCheck: false,
    ranAt: 0,
    status: "ran",
    stoppedEarly: false,
  };

  assert.equal(
    offboardingHttpStatus({ reason: "no_directory", status: "not_configured" }),
    503,
  );
  assert.equal(offboardingHttpStatus({ status: "no_domains" }), 503);
  assert.equal(
    offboardingHttpStatus({ reason: "off", status: "not_configured" }),
    200,
  );
  assert.equal(offboardingHttpStatus({ status: "already_running" }), 200);
  assert.equal(offboardingHttpStatus(ran), 200);
  assert.equal(offboardingHttpStatus({ ...ran, stoppedEarly: true }), 502);
});
