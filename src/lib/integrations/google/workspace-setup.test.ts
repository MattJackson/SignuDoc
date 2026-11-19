import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import type { IntegrationSettingsUpdate } from "../../integration-settings.ts";
import {
  cloudState,
  FAKE_ADMIN_SERVICE_ID,
  fakeServiceAccountUniqueId,
} from "./test-support/fake-cloud.ts";
import {
  FAKE_SERVICE_ACCOUNT_EMAIL,
  startFakeGoogle,
  type FakeGoogle,
} from "./test-support/fake-google.ts";
import {
  buildSetupAuthorizationUrl,
  openSetupState,
  pickerKeyName,
  runWorkspaceSetup,
  sealSetupState,
  setupScopes,
  SETUP_APIS,
  SETUP_STEP_TITLES,
  type SetupEvent,
  type WorkspaceSetupInput,
} from "./workspace-setup.ts";

// The automatic Google Workspace setup against the fake Google server:
// every step, run once and then again (when nothing is left to do), runs
// that start from a half-done setup, and the refusals. Each test has a
// fake Google of its own.

const ADMIN = "ada@example.test";
const NOT_ADMIN = "bob@example.test";
const PROJECT_NUMBER = "123456789012";
const ROLE_PRIVILEGES = [
  { privilegeName: "USERS_RETRIEVE", serviceId: FAKE_ADMIN_SERVICE_ID },
  { privilegeName: "GROUPS_RETRIEVE", serviceId: FAKE_ADMIN_SERVICE_ID },
];
const PICKER_RESTRICTIONS = {
  apiTargets: [{ service: "picker.googleapis.com" }],
  browserKeyRestrictions: {
    allowedReferrers: ["https://sign.example.test/*"],
  },
};

let fake: FakeGoogle;

beforeEach(async () => {
  fake = await startFakeGoogle({
    users: [
      { email: ADMIN, familyName: "Admin", givenName: "Ada", isAdmin: true },
      { email: NOT_ADMIN, familyName: "User", givenName: "Bob" },
    ],
  });
});

afterEach(async () => {
  await fake.close();
});

type Stored = Partial<Record<string, string>>;

function setup(
  stored: Stored,
  overrides: Partial<WorkspaceSetupInput> = {},
): { events: SetupEvent[]; input: WorkspaceSetupInput; tested: string[] } {
  const events: SetupEvent[] = [];
  const tested: string[] = [];
  const input: WorkspaceSetupInput = {
    accessToken: fake.issueAccessToken({
      scopes: setupScopes(true),
      user: ADMIN,
    }),
    adminEmail: ADMIN,
    appName: "BusbarSigner",
    emit: (event) => events.push(event),
    env: fake.env,
    existing: {
      appId: stored["drive.appId"] ?? null,
      customerId: stored["google.customerId"] ?? null,
      directory: stored["google.directory"] ?? null,
      exportDriveId: stored["drive.exportDriveId"] ?? null,
      pickerApiKey: stored["drive.pickerApiKey"] ?? null,
    },
    exportDrive: true,
    projectId: "fake-project",
    projectNumber: null,
    runTests: async ({ exportDriveId }) => {
      tested.push(exportDriveId ?? "none");
      return [{ message: "Found Ada.", name: "Directory", ok: true }];
    },
    save: async (update: IntegrationSettingsUpdate) => {
      for (const [key, value] of Object.entries(update)) {
        if (value === null || value === undefined) {
          delete stored[key];
        } else {
          stored[key] = value;
        }
      }
    },
    serviceAccountEmail: FAKE_SERVICE_ACCOUNT_EMAIL,
    siteUrl: "https://sign.example.test/",
    sleep: async () => undefined,
    ...overrides,
  };

  return { events, input, tested };
}

function outcomes(events: SetupEvent[]) {
  return events
    .filter(
      (event): event is Extract<SetupEvent, { type: "step" }> =>
        event.type === "step" && event.status !== "running",
    )
    .map((event) => [event.id, event.status]);
}

function outcomeOf(events: SetupEvent[], id: string) {
  return outcomes(events).find(([step]) => step === id)?.[1];
}

function refusalOf(events: SetupEvent[]): string {
  const refused = events.find((event) => event.type === "refused");

  return refused?.type === "refused" ? refused.message : "";
}

function serviceAccountMembers(driveId: string) {
  return (cloudState(fake.state).drivePermissions.get(driveId) ?? []).filter(
    (permission) => permission.emailAddress === FAKE_SERVICE_ACCOUNT_EMAIL,
  );
}

test("the sign-in asks for the setup scopes with PKCE, and its state is sealed", () => {
  const url = new URL(
    buildSetupAuthorizationUrl({
      clientId: "client-1",
      codeChallenge: "challenge",
      exportDrive: false,
      redirectUri: "https://sign.example.test/settings/google-setup",
      state: "state-1",
    }),
  );

  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("access_type"), "online");
  assert.ok(
    !url.searchParams.get("scope")?.includes("auth/drive"),
    "no Drive scope without a Shared Drive",
  );
  assert.ok(url.searchParams.get("scope")?.includes("rolemanagement"));

  const env = { BETTER_AUTH_SECRET: "s".repeat(40) };
  const cookie = {
    createdAt: 1000,
    exportDrive: true,
    returnTo: "/onboarding?step=google-workspace",
    state: "state-1",
    userId: "user-1",
    verifier: "verifier",
  };
  const sealed = sealSetupState(cookie, env);

  assert.deepEqual(openSetupState(sealed, env, 1100), cookie);
  assert.equal(openSetupState(sealed, env, 1000 + 11 * 60), null);
  assert.equal(
    openSetupState(sealed, { BETTER_AUTH_SECRET: "t".repeat(40) }, 1100),
    null,
  );
  assert.equal(openSetupState("forged", env, 1100), null);
});

test("every step runs once, then finds everything already in place", async () => {
  const stored: Stored = {};
  const first = setup(stored);

  assert.equal(await runWorkspaceSetup(first.input), true);
  assert.deepEqual(outcomes(first.events), [
    ["apis", "done"],
    ["picker", "done"],
    ["customer", "done"],
    ["role", "done"],
    ["drive", "done"],
    ["tests", "done"],
  ]);

  const cloud = cloudState(fake.state);

  for (const api of SETUP_APIS) {
    assert.ok(cloud.enabledServices.has(api), api);
  }

  const [key] = Array.from(cloud.apiKeys.values());

  assert.equal(key?.displayName, "BusbarSigner Picker");
  assert.deepEqual(key?.restrictions, PICKER_RESTRICTIONS);
  assert.equal(stored["drive.pickerApiKey"], key?.keyString);
  assert.equal(stored["drive.appId"], cloud.projectNumber);
  assert.equal(stored["google.customerId"], cloud.customerId);
  assert.equal(stored["google.directory"], "on");

  const [role] = Array.from(cloud.roles.values());

  assert.equal(role?.roleName, "BusbarSigner directory reader");
  assert.deepEqual(role?.rolePrivileges, ROLE_PRIVILEGES);
  assert.deepEqual(
    cloud.roleAssignments.map((item) => [item.roleId, item.assignedTo]),
    [[role?.roleId, fakeServiceAccountUniqueId(FAKE_SERVICE_ACCOUNT_EMAIL)]],
  );

  const driveId = stored["drive.exportDriveId"];

  assert.equal(
    fake.state.drives.get(driveId ?? "")?.name,
    "BusbarSigner Executed",
  );
  assert.deepEqual(
    cloud.drivePermissions
      .get(driveId ?? "")
      ?.map((permission) => [permission.emailAddress, permission.role]),
    [[FAKE_SERVICE_ACCOUNT_EMAIL, "fileOrganizer"]],
  );
  assert.deepEqual(first.tested, [driveId]);

  const second = setup(stored);

  assert.equal(await runWorkspaceSetup(second.input), true);
  assert.deepEqual(outcomes(second.events), [
    ["apis", "skipped"],
    ["picker", "skipped"],
    ["customer", "skipped"],
    ["role", "skipped"],
    ["drive", "skipped"],
    ["tests", "done"],
  ]);
  assert.equal(cloud.apiKeys.size, 1);
  assert.equal(cloud.roles.size, 1);
  assert.equal(cloud.roleAssignments.length, 1);
  assert.equal(fake.state.drives.size, 1);
});

test("someone who is not a super admin is refused after the APIs", async () => {
  const run = setup(
    {},
    {
      accessToken: fake.issueAccessToken({
        scopes: setupScopes(true),
        user: NOT_ADMIN,
      }),
      adminEmail: NOT_ADMIN,
    },
  );

  assert.equal(await runWorkspaceSetup(run.input), false);
  assert.match(refusalOf(run.events), /not a Workspace super admin/);
  assert.deepEqual(outcomes(run.events), [["apis", "done"]]);
});

test("an Admin SDK that is still being turned on is not taken for a missing super admin", async () => {
  cloudState(fake.state).slowServices.set("admin.googleapis.com", Infinity);

  const run = setup({});

  assert.equal(await runWorkspaceSetup(run.input), false);

  const message = refusalOf(run.events);

  assert.doesNotMatch(message, /not a Workspace super admin/);
  assert.match(message, /still being turned on/);
  assert.deepEqual(outcomes(run.events), [["apis", "done"]]);
});

test("an account with no rights on the Cloud project is stopped at the first step, with Google's status only", async () => {
  cloudState(fake.state).deniedProjectUsers.add(ADMIN);

  const run = setup({});

  assert.equal(await runWorkspaceSetup(run.input), false);

  const failed = run.events.find(
    (event) => event.type === "step" && event.status === "failed",
  );

  assert.equal(failed?.type === "step" && failed.id, "apis");
  assert.equal(failed?.type === "step" && failed.googleStatus, 403);
  assert.match(failed?.type === "step" ? (failed.hint ?? "") : "", /Owner/);
  // Google's own wording is not passed on.
  assert.doesNotMatch(
    JSON.stringify(run.events),
    /The caller does not have permission/,
  );
});

test("failing checks fail the last step with a hint, and a Shared Drive can be left out", async () => {
  const run = setup(
    {},
    {
      exportDrive: false,
      runTests: async () => [
        { message: "403 from the directory.", name: "Directory", ok: false },
      ],
    },
  );

  assert.equal(await runWorkspaceSetup(run.input), false);

  const steps = outcomes(run.events);

  assert.deepEqual(steps.at(-2), ["drive", "skipped"]);
  assert.deepEqual(steps.at(-1), ["tests", "failed"]);

  const failed = run.events.at(-1);

  assert.match(
    failed?.type === "step" ? (failed.hint ?? "") : "",
    /few minutes/,
  );
});

test("a run that runs out of time stops between steps and says which were not run", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });

  let elapsed = 0;
  const wait = (ms: number) => {
    elapsed += ms;
    t.mock.timers.tick(ms);
  };
  // Every Google call takes 15 seconds, the longest a request is let run.
  const slowFetch: typeof fetch = async (url, init) => {
    wait(15_000);
    return fetch(url, init);
  };
  const run = setup(
    {},
    {
      fetchImpl: slowFetch,
      sleep: async (ms) => wait(ms),
    },
  );

  assert.equal(await runWorkspaceSetup(run.input), false);
  // Well inside the 300 seconds the platform allows, so the token can be
  // revoked after.
  assert.ok(elapsed <= 255_000, `ran for ${String(elapsed / 1000)} s`);

  const message = refusalOf(run.events);

  assert.match(message, /time/);
  assert.ok(message.includes(SETUP_STEP_TITLES.tests), message);
  assert.equal(outcomeOf(run.events, "tests"), undefined);
});

test("a progress report that cannot be sent does not stop the setup", async () => {
  const stored: Stored = {};
  const run = setup(stored, {
    emit: () => {
      throw new TypeError("Invalid state: Controller is already closed");
    },
  });

  assert.equal(await runWorkspaceSetup(run.input), true);
  assert.ok(stored["drive.pickerApiKey"]);
  assert.equal(stored["google.directory"], "on");
  assert.ok(stored["drive.exportDriveId"]);
  assert.deepEqual(run.tested, [stored["drive.exportDriveId"]]);
});

test("a Shared Drive someone else made with the same name is not taken over", async () => {
  fake.addDrive({ id: "0AFakeLookalike", name: "BusbarSigner Executed" });

  const stored: Stored = {};
  const run = setup(stored);

  assert.equal(await runWorkspaceSetup(run.input), true);

  const driveId = stored["drive.exportDriveId"] ?? "";

  assert.notEqual(driveId, "0AFakeLookalike");
  assert.equal(fake.state.drives.get(driveId)?.name, "BusbarSigner Executed");
  assert.deepEqual(serviceAccountMembers("0AFakeLookalike"), []);
  assert.equal(serviceAccountMembers(driveId).length, 1);
});

test("a long app name still makes a Picker key within Google's 63 characters", async () => {
  for (const length of [1, 56, 57, 60, 120]) {
    assert.ok(pickerKeyName("A".repeat(length)).length <= 63, String(length));
  }

  const appName = "A".repeat(60);
  const stored: Stored = {};
  const first = setup(stored, { appName });

  await runWorkspaceSetup(first.input);
  assert.equal(outcomeOf(first.events, "picker"), "done");

  const second = setup(stored, { appName });

  await runWorkspaceSetup(second.input);
  assert.equal(outcomeOf(second.events, "picker"), "skipped");
  assert.equal(cloudState(fake.state).apiKeys.size, 1);
});

test("the Shared Drive set where the site runs is the one tested", async () => {
  fake.addDrive({ id: "0AFakeFromEnv", name: "Contracts" });

  const run = setup(
    { "drive.exportDriveId": "0AFakeOldStored" },
    { env: { ...fake.env, GOOGLE_DRIVE_EXPORT_DRIVE_ID: "0AFakeFromEnv" } },
  );

  await runWorkspaceSetup(run.input);
  assert.equal(outcomeOf(run.events, "drive"), "skipped");
  assert.deepEqual(run.tested, ["0AFakeFromEnv"]);
});

test("a Picker key saved without the project number needs attention", async () => {
  cloudState(fake.state).hideProjectNumber = true;

  const stored: Stored = {};
  const run = setup(stored);

  assert.equal(await runWorkspaceSetup(run.input), false);
  assert.equal(outcomeOf(run.events, "picker"), "failed");
  assert.ok(stored["drive.pickerApiKey"], "the key is still saved");
  assert.equal(stored["drive.appId"], undefined);
});

// Runs that start from a half-done setup.

test("an existing Picker key with the wrong restrictions, on a later page, is held again", async () => {
  const cloud = cloudState(fake.state);

  for (let index = 0; index < 300; index += 1) {
    const name = `projects/${PROJECT_NUMBER}/locations/global/keys/other-${String(index)}`;

    cloud.apiKeys.set(name, {
      displayName: `Other ${String(index)}`,
      keyString: `AIzaOther${String(index)}`,
      name,
      restrictions: {},
    });
  }

  const ours = `projects/${PROJECT_NUMBER}/locations/global/keys/ours`;

  cloud.apiKeys.set(ours, {
    displayName: "BusbarSigner Picker",
    keyString: "AIzaOurs",
    name: ours,
    restrictions: {},
  });

  const stored: Stored = {};
  const run = setup(stored);

  await runWorkspaceSetup(run.input);
  assert.equal(outcomeOf(run.events, "picker"), "done");
  assert.equal(cloud.apiKeys.size, 301);
  assert.deepEqual(cloud.apiKeys.get(ours)?.restrictions, PICKER_RESTRICTIONS);
  assert.equal(stored["drive.pickerApiKey"], "AIzaOurs");
});

test("an existing role on a later page that is not assigned yet is assigned", async () => {
  const cloud = cloudState(fake.state);

  for (let index = 0; index < 100; index += 1) {
    cloud.roles.set(`other-${String(index)}`, {
      roleId: `other-${String(index)}`,
      roleName: `Other ${String(index)}`,
      rolePrivileges: [],
    });
  }

  cloud.roles.set("ours", {
    roleId: "ours",
    roleName: "BusbarSigner directory reader",
    rolePrivileges: ROLE_PRIVILEGES,
  });

  const run = setup({});

  await runWorkspaceSetup(run.input);
  assert.equal(outcomeOf(run.events, "role"), "done");
  assert.equal(cloud.roles.size, 101);
  assert.deepEqual(
    cloud.roleAssignments.map((item) => [item.roleId, item.assignedTo]),
    [["ours", fakeServiceAccountUniqueId(FAKE_SERVICE_ACCOUNT_EMAIL)]],
  );
});

test("the saved Shared Drive without the service account gets it added", async () => {
  fake.addDrive({ id: "0AFakeOurs", name: "BusbarSigner Executed" });

  const stored: Stored = { "drive.exportDriveId": "0AFakeOurs" };
  const run = setup(stored);

  await runWorkspaceSetup(run.input);
  assert.equal(outcomeOf(run.events, "drive"), "done");
  assert.equal(stored["drive.exportDriveId"], "0AFakeOurs");
  assert.deepEqual(
    serviceAccountMembers("0AFakeOurs").map((member) => member.role),
    ["fileOrganizer"],
  );
  assert.equal(fake.state.drives.size, 1);
});

test("a saved Shared Drive that is gone is made again", async () => {
  const stored: Stored = { "drive.exportDriveId": "0AFakeGone" };
  const run = setup(stored);

  await runWorkspaceSetup(run.input);
  assert.equal(outcomeOf(run.events, "drive"), "done");

  const driveId = stored["drive.exportDriveId"] ?? "";

  assert.notEqual(driveId, "0AFakeGone");
  assert.equal(fake.state.drives.get(driveId)?.name, "BusbarSigner Executed");
  assert.equal(serviceAccountMembers(driveId).length, 1);
});

test("the service account on a later page of the drive's members is found", async () => {
  fake.addDrive({ id: "0AFakeBusy", name: "BusbarSigner Executed" });

  const members = Array.from({ length: 100 }, (_, index) => ({
    emailAddress: `person${String(index)}@example.test`,
    id: `perm-${String(index)}`,
    role: "reader",
    type: "user",
  }));

  cloudState(fake.state).drivePermissions.set("0AFakeBusy", [
    ...members,
    {
      emailAddress: FAKE_SERVICE_ACCOUNT_EMAIL,
      id: "perm-sa",
      role: "fileOrganizer",
      type: "user",
    },
  ]);

  const run = setup({ "drive.exportDriveId": "0AFakeBusy" });

  await runWorkspaceSetup(run.input);
  assert.equal(outcomeOf(run.events, "drive"), "skipped");
  assert.equal(serviceAccountMembers("0AFakeBusy").length, 1);
});

test("an API that is still coming on is tried again after a wait", async () => {
  cloudState(fake.state).slowServices.set("apikeys.googleapis.com", 3);

  const waits: number[] = [];
  const run = setup(
    {},
    {
      sleep: async (ms) => {
        waits.push(ms);
      },
    },
  );

  assert.equal(await runWorkspaceSetup(run.input), true);
  assert.equal(outcomeOf(run.events, "picker"), "done");
  assert.equal(waits.filter((ms) => ms === 5000).length, 3);
});
