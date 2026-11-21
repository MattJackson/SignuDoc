import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import type { IntegrationSettingsUpdate } from "../../integration-settings.ts";
import { addonAddressProblem } from "./addon/config.ts";
import { buildAddonDeployment } from "./addon/manifest.ts";
import { createGoogleCredentials, GOOGLE_SCOPES } from "./credentials.ts";
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
  ADDON_DEPLOYMENT_ID,
  buildSetupAuthorizationUrl,
  listSetupProjects,
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
const SITE = "https://sign.example.test";
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
    addon: { deployment: buildAddonDeployment({ siteUrl: SITE }) },
    adminEmail: ADMIN,
    appName: "BusbarSigner",
    emit: (event) => events.push(event),
    env: fake.env,
    existing: {
      addonClientId: stored["google.addonClientId"] ?? null,
      addonServiceAccount: stored["google.addonServiceAccount"] ?? null,
      appId: stored["drive.appId"] ?? null,
      cloudProject: stored["google.cloudProject"] ?? null,
      customerId: stored["google.customerId"] ?? null,
      directory: stored["google.directory"] ?? null,
      exportDriveId: stored["drive.exportDriveId"] ?? null,
      pickerApiKey: stored["drive.pickerApiKey"] ?? null,
      serviceAccountKeyName: stored["google.serviceAccountKeyName"] ?? null,
    },
    exportDrive: true,
    identity: {
      fixed: {
        email: FAKE_SERVICE_ACCOUNT_EMAIL,
        source: "service-account-key",
      },
      loginAvailable: false,
      saved: null,
      unreadable: null,
    },
    project: {
      create: false,
      projectId: "fake-project",
      projectNumber: null,
    },
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
    siteUrl: `${SITE}/`,
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
    ["project", "done"],
    ["apis", "done"],
    ["identity", "skipped"],
    ["picker", "done"],
    ["customer", "done"],
    ["role", "done"],
    ["drive", "done"],
    ["addon", "done"],
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
    ["project", "skipped"],
    ["apis", "skipped"],
    ["identity", "skipped"],
    ["picker", "skipped"],
    ["customer", "skipped"],
    ["role", "skipped"],
    ["drive", "skipped"],
    ["addon", "skipped"],
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
  assert.deepEqual(outcomes(run.events), [
    ["project", "done"],
    ["apis", "done"],
  ]);
});

test("an Admin SDK that is still being turned on is not taken for a missing super admin", async () => {
  cloudState(fake.state).slowServices.set("admin.googleapis.com", Infinity);

  const run = setup({});

  assert.equal(await runWorkspaceSetup(run.input), false);

  const message = refusalOf(run.events);

  assert.doesNotMatch(message, /not a Workspace super admin/);
  assert.match(message, /still being turned on/);
  assert.deepEqual(outcomes(run.events), [
    ["project", "done"],
    ["apis", "done"],
  ]);
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

  assert.equal(outcomeOf(run.events, "drive"), "skipped");
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

test("the last step's checks are not started without the time they need", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });

  let elapsed = 0;
  const wait = (ms: number) => {
    elapsed += ms;
    t.mock.timers.tick(ms);
  };
  // Steps a to d end just inside the budget; the checks of step f make up
  // to four requests of 15 seconds each.
  const run = setup(
    {},
    {
      exportDrive: false,
      fetchImpl: async (url, init) => {
        wait(14_000);
        return fetch(url, init);
      },
      runTests: async () => {
        wait(60_000);
        return [{ message: "Found Ada.", name: "Directory", ok: true }];
      },
      sleep: async (ms) => wait(ms),
    },
  );

  assert.equal(await runWorkspaceSetup(run.input), false);

  // The revoke after it can take one more request of 15 seconds, and all
  // of it has to fit in the route's 300.
  assert.ok(elapsed + 15_000 <= 300_000, `ran for ${String(elapsed / 1000)} s`);
  assert.ok(elapsed <= 255_000, `ran for ${String(elapsed / 1000)} s`);
  assert.ok(refusalOf(run.events).includes(SETUP_STEP_TITLES.tests));
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

// The project choice, the site's own identity and the add-on.

const OWN_ACCOUNT =
  "busbarsigner-workspace@fake-project.iam.gserviceaccount.com";

/** The site has no identity of its own yet, unless told otherwise. */
function ownIdentity(
  overrides: Partial<WorkspaceSetupInput["identity"]> = {},
): WorkspaceSetupInput["identity"] {
  return {
    fixed: null,
    loginAvailable: false,
    saved: null,
    unreadable: null,
    ...overrides,
  };
}

function failedStep(events: SetupEvent[], id: string) {
  const event = events.find(
    (item) =>
      item.type === "step" && item.id === id && item.status === "failed",
  );

  return event?.type === "step" ? event : null;
}

test("the projects to choose from are listed with their numbers and the organization", async () => {
  const cloud = cloudState(fake.state);

  cloud.projects.set("other-project", {
    name: "Another project",
    number: "222333444555",
    parent: null,
    projectId: "other-project",
  });

  const listed = await listSetupProjects({
    accessToken: fake.issueAccessToken({
      scopes: setupScopes(false),
      user: ADMIN,
    }),
    clientProject: "777888999000",
    deadline: Date.now() + 60_000,
    env: fake.env,
    hostedDomain: "example.test",
    sleep: async () => undefined,
  });

  assert.equal(listed.problem, null);
  assert.equal(listed.organization, "organizations/555000111");
  assert.deepEqual(
    listed.projects.map((item) => [item.projectId, item.number]),
    [
      ["other-project", "222333444555"],
      ["fake-project", "123456789012"],
    ],
  );
  assert.ok(
    cloud.enabledServices.has("cloudresourcemanager.googleapis.com"),
    "the sign-in client's project can list projects",
  );
});

test("an account that cannot list projects is told so, and can still make one", async () => {
  cloudState(fake.state).deniedProjectUsers.add(ADMIN);

  const listed = await listSetupProjects({
    accessToken: fake.issueAccessToken({
      scopes: setupScopes(false),
      user: ADMIN,
    }),
    clientProject: null,
    deadline: Date.now() + 60_000,
    env: fake.env,
    hostedDomain: null,
    sleep: async () => undefined,
  });

  assert.deepEqual(listed.projects, []);
  assert.match(listed.problem ?? "", /cannot list Cloud projects/);
});

test("a new project is made in the organization, saved, and used for every step", async () => {
  const stored: Stored = {};
  const run = setup(stored, {
    project: {
      create: true,
      name: "BusbarSigner Workspace",
      parent: "organizations/555000111",
      projectId: "busbarsigner-ws-abc123",
    },
  });

  assert.equal(await runWorkspaceSetup(run.input), true);
  assert.equal(outcomeOf(run.events, "project"), "done");

  const made = cloudState(fake.state).projects.get("busbarsigner-ws-abc123");

  assert.equal(made?.name, "BusbarSigner Workspace");
  assert.equal(made?.parent, "organizations/555000111");
  assert.equal(stored["google.cloudProject"], "busbarsigner-ws-abc123");
  assert.equal(stored["drive.appId"], made?.number);
  assert.ok(
    cloudState(fake.state).addonDeployments.has(
      `busbarsigner-ws-abc123/${ADDON_DEPLOYMENT_ID}`,
    ),
  );
});

test("off Google Cloud the setup makes the site's own service account and stores a key for it", async () => {
  const stored: Stored = {};
  const first = setup(stored, { identity: ownIdentity() });

  assert.equal(await runWorkspaceSetup(first.input), true);
  assert.equal(outcomeOf(first.events, "identity"), "done");

  const cloud = cloudState(fake.state);
  const key = JSON.parse(stored["google.serviceAccountKey"] ?? "{}") as {
    client_email?: string;
    private_key?: string;
  };

  assert.ok(cloud.serviceAccounts.has(OWN_ACCOUNT));
  assert.equal(key.client_email, OWN_ACCOUNT);
  assert.match(key.private_key ?? "", /PRIVATE KEY/);
  assert.equal(stored["google.impersonateServiceAccount"], undefined);
  // The directory role and the Shared Drive go to the new account.
  assert.deepEqual(
    cloud.roleAssignments.map((item) => item.assignedTo),
    [fakeServiceAccountUniqueId(OWN_ACCOUNT)],
  );
  assert.equal(
    cloud.drivePermissions.get(stored["drive.exportDriveId"] ?? "")?.[0]
      ?.emailAddress,
    OWN_ACCOUNT,
  );

  // The stored key is the site's identity from now on.
  const credentials = createGoogleCredentials({
    env: fake.env,
    stored: { key: stored["google.serviceAccountKey"] },
  });

  assert.equal(credentials?.source, "stored-key");
  assert.equal(await credentials?.getServiceAccountEmail(), OWN_ACCOUNT);

  const second = setup(stored, {
    identity: ownIdentity({
      saved: { email: OWN_ACCOUNT, source: "stored-key" },
    }),
  });

  assert.equal(await runWorkspaceSetup(second.input), true);
  assert.equal(outcomeOf(second.events, "identity"), "skipped");
  assert.equal(cloud.keysMade.get(OWN_ACCOUNT), 1, "no second key");
});

test("where the organization forbids keys, the administrator may impersonate the account and is told how", async () => {
  const cloud = cloudState(fake.state);

  cloud.refuseKeys = true;

  const stored: Stored = {};
  const run = setup(stored, { identity: ownIdentity() });

  assert.equal(await runWorkspaceSetup(run.input), false);

  const failed = failedStep(run.events, "identity");

  assert.ok(failed);
  assert.match(failed.detail, /iam\.disableServiceAccountKeyCreation/);
  assert.match(failed.detail, new RegExp(OWN_ACCOUNT.replace(/\./g, "\\.")));
  assert.match(failed.hint ?? "", /gcloud auth application-default login/);
  assert.match(
    failed.hint ?? "",
    /-e GOOGLE_IMPERSONATE_SERVICE_ACCOUNT=busbarsigner-workspace@/,
  );
  assert.match(failed.hint ?? "", /application_default_credentials\.json/);
  assert.equal(stored["google.serviceAccountKey"], undefined);
  assert.equal(stored["google.impersonateServiceAccount"], OWN_ACCOUNT);
  assert.deepEqual(cloud.iamPolicies.get(OWN_ACCOUNT)?.bindings, [
    {
      members: [`user:${ADMIN}`],
      role: "roles/iam.serviceAccountTokenCreator",
    },
  ]);
  // The rest of the setup still uses the account.
  assert.equal(outcomeOf(run.events, "role"), "done");
  assert.deepEqual(
    cloud.roleAssignments.map((item) => item.assignedTo),
    [fakeServiceAccountUniqueId(OWN_ACCOUNT)],
  );

  // Run again: the grant is not added twice.
  const again = setup(stored, { identity: ownIdentity() });

  await runWorkspaceSetup(again.input);
  assert.equal(
    cloud.iamPolicies.get(OWN_ACCOUNT)?.bindings[0]?.members.length,
    1,
  );
});

test("on Cloud Run the account the site runs as is used, and no account or key is made", async () => {
  const run = setup(
    {},
    {
      identity: ownIdentity({
        fixed: { email: FAKE_SERVICE_ACCOUNT_EMAIL, source: "metadata" },
      }),
    },
  );

  assert.equal(await runWorkspaceSetup(run.input), true);

  const identity = run.events.find(
    (event) =>
      event.type === "step" &&
      event.id === "identity" &&
      event.status === "skipped",
  );

  assert.match(
    identity?.type === "step" ? identity.detail : "",
    /Runs on Google Cloud as signudoc@fake-project/,
  );
  assert.equal(cloudState(fake.state).serviceAccounts.size, 0);
  assert.equal(cloudState(fake.state).keysMade.size, 0);
});

test("the add-on is deployed, installed for the administrator, and updated when the site moves", async () => {
  const stored: Stored = {};
  const first = setup(stored);
  const cloud = cloudState(fake.state);
  const key = `fake-project/${ADDON_DEPLOYMENT_ID}`;

  assert.equal(await runWorkspaceSetup(first.input), true);
  assert.equal(outcomeOf(first.events, "addon"), "done");
  assert.ok(cloud.addonInstalls.has(`${key}/${ADMIN}`));
  assert.equal(
    stored["google.addonServiceAccount"],
    "service-123456789012@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
  );
  assert.equal(stored["google.addonClientId"], "1123456789012");

  const deployed = cloud.addonDeployments.get(key)?.deployment as {
    addOns?: { common?: { homepageTrigger?: { runFunction?: string } } };
  };

  assert.equal(
    deployed.addOns?.common?.homepageTrigger?.runFunction,
    "https://sign.example.test/api/google/addon/homepage",
  );

  const moved = setup(stored, {
    addon: {
      deployment: buildAddonDeployment({
        siteUrl: "https://sign2.example.test",
      }),
    },
  });

  await runWorkspaceSetup(moved.input);
  assert.equal(outcomeOf(moved.events, "addon"), "done");
  assert.equal(
    (
      cloud.addonDeployments.get(key)?.deployment as {
        addOns?: { common?: { homepageTrigger?: { runFunction?: string } } };
      }
    ).addOns?.common?.homepageTrigger?.runFunction,
    "https://sign2.example.test/api/google/addon/homepage",
  );
  assert.equal(cloud.addonDeployments.size, 1);
});

test("without a public HTTPS address the add-on is skipped and says why", async () => {
  for (const address of [
    "http://localhost:8080",
    "https://localhost",
    "http://sign.example.test",
    "https://192.168.1.20",
    "https://box.local",
  ]) {
    assert.match(addonAddressProblem(address) ?? "", /public HTTPS/, address);
  }

  assert.equal(addonAddressProblem("https://sign.example.test"), null);

  const run = setup(
    {},
    {
      addon: { skipped: addonAddressProblem("http://localhost:8080")! },
    },
  );

  assert.equal(await runWorkspaceSetup(run.input), true);
  assert.equal(outcomeOf(run.events, "addon"), "skipped");
  assert.equal(cloudState(fake.state).addonDeployments.size, 0);
});

test("the gcloud login impersonates the account the setup made", async () => {
  const cloud = cloudState(fake.state);

  cloud.serviceAccounts.set(OWN_ACCOUNT, {
    displayName: "BusbarSigner Workspace",
    email: OWN_ACCOUNT,
    projectId: "fake-project",
    uniqueId: fakeServiceAccountUniqueId(OWN_ACCOUNT),
  });
  cloud.iamPolicies.set(OWN_ACCOUNT, {
    bindings: [
      {
        members: [`user:${ADMIN}`],
        role: "roles/iam.serviceAccountTokenCreator",
      },
    ],
    etag: "e1",
  });

  const adc = JSON.stringify({
    client_id: "fake-client-id.apps.googleusercontent.com",
    client_secret: "fake-client-secret",
    refresh_token: fake.issueRefreshToken({
      scopes: [GOOGLE_SCOPES.cloudPlatform],
      user: ADMIN,
    }),
    type: "authorized_user",
  });
  const credentials = createGoogleCredentials({
    env: { ...fake.env, HOME: "/home/node" },
    readFile: (file) =>
      file === "/home/node/.config/gcloud/application_default_credentials.json"
        ? adc
        : null,
    stored: { impersonate: OWN_ACCOUNT },
  });

  assert.equal(credentials?.source, "impersonation");
  assert.equal(await credentials?.getServiceAccountEmail(), OWN_ACCOUNT);

  const token = await credentials!.getAccessToken({
    scopes: [GOOGLE_SCOPES.drive],
  });

  assert.equal(fake.state.accessTokens.get(token)?.serviceAccount, OWN_ACCOUNT);

  // Someone without Token Creator on it cannot.
  cloud.iamPolicies.delete(OWN_ACCOUNT);

  const refused = createGoogleCredentials({
    env: { ...fake.env, HOME: "/home/node" },
    readFile: () => adc,
    stored: { impersonate: OWN_ACCOUNT },
  });

  await assert.rejects(
    refused!.getAccessToken({ scopes: [GOOGLE_SCOPES.directoryUserReadonly] }),
    /IAM generateAccessToken failed with 403/,
  );
});

// Keys are not left behind, and a working identity is not given up.

function keysOf(email: string): string[] {
  return cloudState(fake.state).accountKeys.get(email) ?? [];
}

test("an identity set where the site runs that cannot be read is reported, and no account or key is made", async () => {
  const configured = "app@other-project.iam.gserviceaccount.com";
  const run = setup(
    {},
    {
      identity: ownIdentity({
        unreadable: {
          email: configured,
          problem:
            "GOOGLE_IMPERSONATE_SERVICE_ACCOUNT is set, but no gcloud application-default login is mounted into the container.",
        },
      }),
    },
  );

  assert.equal(await runWorkspaceSetup(run.input), false);

  const failed = failedStep(run.events, "identity");

  assert.match(failed?.detail ?? "", /no gcloud application-default login/);
  assert.equal(cloudState(fake.state).serviceAccounts.size, 0);
  assert.equal(cloudState(fake.state).keysMade.size, 0);
  // The rest of the setup uses the account the environment names.
  assert.deepEqual(
    cloudState(fake.state).roleAssignments.map((item) => item.assignedTo),
    [fakeServiceAccountUniqueId(configured)],
  );
});

test("a precondition failure that is not the key policy is not taken for a refusal", async () => {
  cloudState(fake.state).keyFailure = "precondition";

  const stored: Stored = {};
  const run = setup(stored, { identity: ownIdentity() });

  assert.equal(await runWorkspaceSetup(run.input), false);
  assert.equal(failedStep(run.events, "identity")?.googleStatus, 400);
  assert.equal(stored["google.impersonateServiceAccount"], undefined);
  assert.equal(cloudState(fake.state).iamPolicies.size, 0);
});

test("the key an earlier run made is deleted when a new one is made", async () => {
  const stored: Stored = {};

  await runWorkspaceSetup(setup(stored, { identity: ownIdentity() }).input);

  const firstName = stored["google.serviceAccountKeyName"];

  assert.ok(firstName?.endsWith(`/keys/${keysOf(OWN_ACCOUNT)[0] ?? ""}`));

  // The stored key could not be read any more (the auth secret changed),
  // so the next run makes another.
  delete stored["google.serviceAccountKey"];

  const again = setup(stored, { identity: ownIdentity() });

  assert.equal(await runWorkspaceSetup(again.input), true);
  assert.equal(keysOf(OWN_ACCOUNT).length, 1, "the old key is gone");
  assert.notEqual(stored["google.serviceAccountKeyName"], firstName);
  assert.equal(cloudState(fake.state).keysMade.get(OWN_ACCOUNT), 2);
});

test("an account at Google's limit of 10 keys is reported, and nothing is deleted", async () => {
  const cloud = cloudState(fake.state);

  cloud.serviceAccounts.set(OWN_ACCOUNT, {
    displayName: "BusbarSigner Workspace",
    email: OWN_ACCOUNT,
    projectId: "fake-project",
    uniqueId: fakeServiceAccountUniqueId(OWN_ACCOUNT),
  });
  cloud.accountKeys.set(
    OWN_ACCOUNT,
    Array.from({ length: 10 }, (_, index) => `old-${String(index)}`),
  );

  const run = setup({}, { identity: ownIdentity() });

  assert.equal(await runWorkspaceSetup(run.input), false);

  const failed = failedStep(run.events, "identity");

  assert.match(failed?.detail ?? "", /10 keys/);
  assert.match(failed?.hint ?? "", /Delete/);
  assert.equal(keysOf(OWN_ACCOUNT).length, 10);
});

test("a working stored key is kept when keys are refused and no gcloud login is mounted", async () => {
  const cloud = cloudState(fake.state);
  const oldAccount = "signudoc@fake-project.iam.gserviceaccount.com";

  cloud.refuseKeys = true;

  const stored: Stored = { "google.serviceAccountKey": '{"old":"key"}' };
  const run = setup(stored, {
    identity: ownIdentity({
      saved: { email: oldAccount, source: "stored-key" },
    }),
  });

  await runWorkspaceSetup(run.input);
  assert.equal(stored["google.serviceAccountKey"], '{"old":"key"}');
  assert.equal(stored["google.impersonateServiceAccount"], OWN_ACCOUNT);
  assert.match(
    failedStep(run.events, "identity")?.detail ?? "",
    /keeps using the stored key/,
  );

  // With the login mounted, the next run switches to it.
  const mounted = setup(stored, {
    identity: ownIdentity({
      loginAvailable: true,
      saved: { email: oldAccount, source: "stored-key" },
    }),
  });

  await runWorkspaceSetup(mounted.input);
  assert.equal(stored["google.serviceAccountKey"], undefined);
});

test("the account's IAM policy is read as version 3 and written again after a conflict", async () => {
  const cloud = cloudState(fake.state);

  cloud.refuseKeys = true;
  cloud.iamEtagConflicts = 1;

  const run = setup({}, { identity: ownIdentity() });

  await runWorkspaceSetup(run.input);
  assert.ok(cloud.requestedPolicyVersions.length >= 2);
  assert.ok(cloud.requestedPolicyVersions.every((version) => version === 3));
  assert.deepEqual(cloud.iamPolicies.get(OWN_ACCOUNT)?.bindings, [
    {
      members: [`user:${ADMIN}`],
      role: "roles/iam.serviceAccountTokenCreator",
    },
  ]);
});
