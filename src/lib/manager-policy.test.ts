import assert from "node:assert/strict";
import { test } from "node:test";

import type { Pool } from "pg";

import { replaceDbPoolForTests, type DbExecutor } from "./db/connection.ts";
import { invalidateIntegrationSettingsCache } from "./integration-settings.ts";
import { GoogleCredentialsError } from "./integrations/google/credentials.ts";
import {
  DirectoryError,
  type DirectoryClient,
  type DirectoryUser,
} from "./integrations/google/directory.ts";
import {
  checkManagerPolicy,
  describeSenderManagerProblem,
  findSenderManager,
  hasManagerApprovalFirst,
  parseTeamIdList,
  readManagerPolicy,
  type ManagerPolicy,
} from "./manager-policy.ts";

// The sender's manager from the directory and the administrator's rule
// about their approval. The team limit needs a database and is covered in
// manager-policy.dbtest.ts.

/** Never asked: these tests use a rule for everyone. */
const noDatabase = {} as DbExecutor;

function directoryOf(
  entries: Record<string, Partial<DirectoryUser> | null>,
  { fail = false }: { fail?: boolean } = {},
): DirectoryClient {
  return {
    getUser: async (email) => {
      if (fail) {
        throw new DirectoryError(
          "Google's directory could not be reached.",
          null,
        );
      }

      const entry = entries[email.toLowerCase()];

      return entry === undefined || entry === null
        ? null
        : {
            archived: false,
            email: email.toLowerCase(),
            managerEmail: null,
            name: "",
            suspended: false,
            ...entry,
          };
    },
    isGroupMember: async () => false,
    listUserGroups: async () => [],
    searchUsers: async () => [],
  };
}

const directory = directoryOf({
  "boss@example.com": { name: "Bea Boss" },
  "gone-boss@example.com": { suspended: true },
  "loner@example.com": {},
  "pat@example.com": { managerEmail: "boss@example.com" },
  "sam@example.com": { managerEmail: "gone-boss@example.com" },
});

function policy(mode: ManagerPolicy["mode"]): ManagerPolicy {
  return { mode, source: "settings", teamIds: [] };
}

test("the rule is off unless set, and the environment wins", () => {
  assert.equal(readManagerPolicy({}, null).mode, "off");
  assert.equal(
    readManagerPolicy({}, { "people.managerPolicy": "suggest" }).mode,
    "suggest",
  );
  assert.deepEqual(
    readManagerPolicy(
      { MANAGER_APPROVAL: "require" },
      {
        "people.managerPolicy": "suggest",
        "people.managerPolicyTeams": "t1, t2,,t1",
      },
    ),
    { mode: "require", source: "env", teamIds: ["t1", "t2"] },
  );
  // Anything else is not a rule.
  assert.equal(
    readManagerPolicy({}, { "people.managerPolicy": "always" }).mode,
    "off",
  );
  assert.deepEqual(parseTeamIdList(undefined), []);
});

test("the manager comes from the sender's own directory entry", async () => {
  assert.deepEqual(await findSenderManager("Pat@example.com", { directory }), {
    manager: { email: "boss@example.com", name: "Bea Boss" },
    status: "found",
  });
  assert.deepEqual(
    await findSenderManager("loner@example.com", { directory }),
    {
      status: "no_manager",
    },
  );
  assert.deepEqual(await findSenderManager("sam@example.com", { directory }), {
    email: "gone-boss@example.com",
    status: "manager_inactive",
  });
  assert.deepEqual(
    await findSenderManager("stranger@example.com", { directory }),
    { status: "not_in_directory" },
  );
  assert.deepEqual(
    await findSenderManager("pat@example.com", { directory: null }),
    { status: "directory_off" },
  );
  assert.deepEqual(
    await findSenderManager("pat@example.com", {
      directory: directoryOf({}, { fail: true }),
    }),
    { status: "lookup_failed" },
  );
});

test("every problem finding the manager is said in words", () => {
  for (const problem of [
    { status: "directory_off" },
    { status: "not_in_directory" },
    { status: "no_manager" },
    { email: "x@example.com", status: "manager_inactive" },
    { status: "lookup_failed" },
  ] as const) {
    assert.ok(describeSenderManagerProblem(problem).length > 20);
  }
});

test("only an approver in the first step counts as the manager approving first", () => {
  const manager = "boss@example.com";

  assert.equal(
    hasManagerApprovalFirst(
      [
        {
          email: "Boss@example.com",
          role: "approver",
          signOrder: 1,
          signingStep: 1,
        },
        {
          email: "client@example.com",
          role: "signer",
          signOrder: 2,
          signingStep: 2,
        },
      ],
      manager,
    ),
    true,
  );
  // A signer, not an approver.
  assert.equal(
    hasManagerApprovalFirst(
      [{ email: manager, role: "signer", signOrder: 1, signingStep: 1 }],
      manager,
    ),
    false,
  );
  // An approver, but after the customer.
  assert.equal(
    hasManagerApprovalFirst(
      [
        {
          email: "client@example.com",
          role: "signer",
          signOrder: 1,
          signingStep: 1,
        },
        { email: manager, role: "approver", signOrder: 2, signingStep: 2 },
      ],
      manager,
    ),
    false,
  );
  // At the same time as the customer, the customer is invited at once, so
  // the manager is not first.
  assert.equal(
    hasManagerApprovalFirst(
      [
        {
          email: "client@example.com",
          role: "signer",
          signOrder: 1,
          signingStep: 1,
        },
        { email: manager, role: "approver", signOrder: 2, signingStep: 1 },
      ],
      manager,
    ),
    false,
  );
  assert.equal(
    hasManagerApprovalFirst(
      [
        { email: manager, role: "approver", signOrder: 1, signingStep: 1 },
        {
          email: "client@example.com",
          role: "signer",
          signOrder: 2,
          signingStep: 1,
        },
      ],
      manager,
    ),
    false,
  );
  // Alone in the first step, with the customer after.
  assert.equal(
    hasManagerApprovalFirst(
      [
        { email: manager, role: "approver", signOrder: 1, signingStep: 1 },
        {
          email: "client@example.com",
          role: "signer",
          signOrder: 2,
          signingStep: 2,
        },
      ],
      manager,
    ),
    true,
  );
});

test("an error that is not the directory's own is still a failed lookup", async () => {
  const broken: DirectoryClient = {
    ...directory,
    getUser: () => Promise.reject(new Error("token exchange refused")),
  };

  assert.deepEqual(
    await findSenderManager("pat@example.com", { directory: broken }),
    { status: "lookup_failed" },
  );

  const suggested = await checkManagerPolicy(
    { email: "pat@example.com", id: "user-pat" },
    [
      {
        email: "client@example.com",
        role: "signer",
        signOrder: 1,
        signingStep: 1,
      },
    ],
    { database: noDatabase, directory: broken, policy: policy("suggest") },
  );

  assert.equal(suggested.status, "suggested");
});

test("a directory that cannot be set up is a failed lookup, not a directory that is off", async () => {
  const unreachable = {
    query: () => Promise.reject(new Error("connection refused")),
  } as unknown as Pool;
  const replaced = replaceDbPoolForTests(unreachable);

  invalidateIntegrationSettingsCache();

  try {
    assert.deepEqual(await findSenderManager("pat@example.com"), {
      status: "lookup_failed",
    });
  } finally {
    invalidateIntegrationSettingsCache();

    if (replaced) {
      replaceDbPoolForTests(replaced);
    }
  }
});

const sender = { email: "pat@example.com", id: "user-pat" };
const customerOnly = [
  { email: "client@example.com", role: "signer", signOrder: 1, signingStep: 1 },
];
const managerFirst = [
  { email: "boss@example.com", role: "approver", signOrder: 1, signingStep: 1 },
  { email: "client@example.com", role: "signer", signOrder: 2, signingStep: 2 },
];

test("require mode blocks a send without the manager approving first", async () => {
  const blocked = await checkManagerPolicy(sender, customerOnly, {
    database: noDatabase,
    directory,
    policy: policy("require"),
  });

  assert.equal(blocked.status, "blocked");
  assert.match(blocked.status === "blocked" ? blocked.message : "", /Bea Boss/);
  assert.deepEqual(
    await checkManagerPolicy(sender, managerFirst, {
      database: noDatabase,
      directory,
      policy: policy("require"),
    }),
    { status: "satisfied" },
  );
});

test("require mode blocks with the reason when the manager cannot be found", async () => {
  for (const [who, pattern] of [
    [{ email: "loner@example.com", id: "u1" }, /names no manager/],
    [{ email: "sam@example.com", id: "u2" }, /suspended or no longer exists/],
  ] as const) {
    const result = await checkManagerPolicy(who, customerOnly, {
      database: noDatabase,
      directory,
      policy: policy("require"),
    });

    assert.equal(result.status, "blocked");
    assert.match(result.status === "blocked" ? result.message : "", pattern);
  }

  // A directory that does not answer never lets a send through.
  const failed = await checkManagerPolicy(sender, customerOnly, {
    database: noDatabase,
    directory: directoryOf({}, { fail: true }),
    policy: policy("require"),
  });

  assert.equal(failed.status, "blocked");
});

test("suggest mode only suggests, and off and Part 11 say nothing", async () => {
  const suggested = await checkManagerPolicy(sender, customerOnly, {
    database: noDatabase,
    directory,
    policy: policy("suggest"),
  });

  assert.equal(suggested.status, "suggested");
  assert.deepEqual(
    suggested.status === "suggested" ? suggested.manager : null,
    { email: "boss@example.com", name: "Bea Boss" },
  );
  assert.deepEqual(
    await checkManagerPolicy(sender, customerOnly, {
      database: noDatabase,
      directory,
      policy: policy("off"),
    }),
    { status: "not_applicable" },
  );
  assert.deepEqual(
    await checkManagerPolicy(sender, customerOnly, {
      database: noDatabase,
      directory,
      part11: true,
      policy: policy("require"),
    }),
    { status: "not_applicable" },
  );
});

test("a Google credentials failure is a lookup that could not be done", async () => {
  const failing: DirectoryClient = {
    ...directoryOf({}),
    getUser: async () => {
      throw new GoogleCredentialsError("The token endpoint refused.");
    },
  };

  assert.deepEqual(
    await findSenderManager("pat@example.com", { directory: failing }),
    { status: "lookup_failed" },
  );
});
