import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { addInAddressProblem } from "../../../add-in-support.ts";
import type {
  WorkspaceSettings,
  WorkspaceSettingsUpdate,
} from "../../../settings.ts";
import type { WorkspaceSetupEvent } from "../../../types.ts";
import {
  buildAddonDeployment,
  DEFAULT_DEPLOYMENT_ID,
} from "../addon/manifest.ts";
import { createGoogleCredentials, GOOGLE_SCOPES } from "../credentials.ts";
import {
  cloudState,
  FAKE_ADMIN_SERVICE_ID,
  fakeServiceAccountUniqueId,
} from "../test-support/fake-cloud.ts";
import {
  FAKE_SERVICE_ACCOUNT_EMAIL,
  startFakeGoogle,
  type FakeGoogle,
} from "../test-support/fake-google.ts";
import {
  buildSetupAuthorizationUrl,
  listSetupProjects,
  setupScopes,
} from "./automatic.ts";
import { pickerKeyName, SETUP_APIS, SETUP_STEP_TITLES } from "./names.ts";
import { runGoogleSetupSteps, type GoogleSetupStepsInput } from "./steps.ts";

// The steps of the automatic Google Workspace setup against the fake Google
// server: every step, run once and then again (when nothing is left to do),
// runs that start from a half-done setup, the site's own identity made
// without a key, the time budget, and the refusals with Google's status
// only. Each test has a fake Google of its own.

const ADMIN = "ada@example.test";
const NOT_ADMIN = "bob@example.test";
const PROJECT_NUMBER = "123456789012";
const SITE = "https://sign.example.test";
const OWN_ACCOUNT =
  "busbarsigner-workspace@fake-project.iam.gserviceaccount.com";
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

function setup(
  stored: WorkspaceSettings,
  overrides: Partial<GoogleSetupStepsInput> = {},
): {
  events: WorkspaceSetupEvent[];
  input: GoogleSetupStepsInput;
  tested: string[];
} {
  const events: WorkspaceSetupEvent[] = [];
  const tested: string[] = [];
  const input: GoogleSetupStepsInput = {
    accessToken: fake.issueAccessToken({
      scopes: setupScopes(true),
      user: ADMIN,
    }),
    addon: { deployment: buildAddonDeployment({ siteUrl: SITE }) },
    adminEmail: ADMIN,
    appName: "BusbarSigner",
    emit: (event) => events.push(event),
    env: fake.env,
    exportDrive: true,
    identity: {
      fixed: {
        email: FAKE_SERVICE_ACCOUNT_EMAIL,
        source: "service-account-key",
      },
      unreadable: null,
    },
    project: {
      create: false,
      projectId: "fake-project",
      projectNumber: null,
    },
    runTests: async ({ exportDestination }) => {
      tested.push(exportDestination ?? "none");
      return [{ message: "Found Ada.", name: "Directory", ok: true }];
    },
    save: async (update: WorkspaceSettingsUpdate) => {
      for (const [key, value] of Object.entries(update) as Array<
        [keyof WorkspaceSettings, string | null | undefined]
      >) {
        if (value === null || value === undefined) {
          delete stored[key];
        } else {
          stored[key] = value;
        }
      }
    },
    siteUrl: `${SITE}/`,
    sleep: async () => undefined,
    // A copy, as the caller reads the stored settings once per run.
    stored: { ...stored },
    ...overrides,
  };

  return { events, input, tested };
}

type StepEvent = Extract<WorkspaceSetupEvent, { type: "step" }>;

function outcomes(events: WorkspaceSetupEvent[]) {
  return events
    .filter(
      (event): event is StepEvent =>
        event.type === "step" && event.status !== "running",
    )
    .map((event) => [event.id, event.status]);
}

function outcomeOf(events: WorkspaceSetupEvent[], id: string) {
  return outcomes(events).find(([step]) => step === id)?.[1];
}

function stepOf(events: WorkspaceSetupEvent[], id: string): StepEvent | null {
  const event = events.find(
    (item) =>
      item.type === "step" && item.id === id && item.status !== "running",
  );

  return event?.type === "step" ? event : null;
}

function refusalOf(events: WorkspaceSetupEvent[]): string {
  const refused = events.find((event) => event.type === "refused");

  return refused?.type === "refused" ? refused.message : "";
}

function serviceAccountMembers(driveId: string, email: string) {
  return (cloudState(fake.state).drivePermissions.get(driveId) ?? []).filter(
    (permission) => permission.emailAddress === email,
  );
}

test("the sign-in asks for the setup scopes with PKCE and no refresh token", () => {
  const url = new URL(
    buildSetupAuthorizationUrl({
      clientId: "client-1",
      codeChallenge: "challenge",
      exportDrive: false,
      redirectUri: `${SITE}/settings/workspace-setup`,
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
});

test("every step runs once, then finds everything already in place", async () => {
  const stored: WorkspaceSettings = {};
  const first = setup(stored);

  assert.equal(await runGoogleSetupSteps(first.input), true);
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
  assert.equal(stored["google.pickerApiKey"], key?.keyString);
  assert.equal(stored["google.pickerAppId"], cloud.projectNumber);
  assert.equal(stored["google.customerId"], cloud.customerId);
  assert.equal(stored["google.cloudProject"], "fake-project");
  assert.equal(stored["directory.enabled"], "on");

  const [role] = Array.from(cloud.roles.values());

  assert.equal(role?.roleName, "BusbarSigner directory reader");
  assert.deepEqual(role?.rolePrivileges, ROLE_PRIVILEGES);
  assert.deepEqual(
    cloud.roleAssignments.map((item) => [item.roleId, item.assignedTo]),
    [[role?.roleId, fakeServiceAccountUniqueId(FAKE_SERVICE_ACCOUNT_EMAIL)]],
  );

  const driveId = stored["files.exportDestination"] ?? "";

  assert.equal(fake.state.drives.get(driveId)?.name, "BusbarSigner Executed");
  assert.deepEqual(
    cloud.drivePermissions
      .get(driveId)
      ?.map((permission) => [permission.emailAddress, permission.role]),
    [[FAKE_SERVICE_ACCOUNT_EMAIL, "fileOrganizer"]],
  );
  assert.deepEqual(first.tested, [driveId]);
  // Nothing secret is saved: no key of any kind.
  assert.equal(cloud.keysMade.size, 0);

  const second = setup(stored);

  assert.equal(await runGoogleSetupSteps(second.input), true);
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

  assert.equal(await runGoogleSetupSteps(run.input), false);
  assert.match(refusalOf(run.events), /not a Workspace super admin/);
  assert.deepEqual(outcomes(run.events), [
    ["project", "done"],
    ["apis", "done"],
  ]);
});

test("an Admin SDK that is still being turned on is not taken for a missing super admin", async () => {
  cloudState(fake.state).slowServices.set("admin.googleapis.com", Infinity);

  const run = setup({});

  assert.equal(await runGoogleSetupSteps(run.input), false);

  const message = refusalOf(run.events);

  assert.doesNotMatch(message, /not a Workspace super admin/);
  assert.match(message, /still being turned on/);
});

test("an account with no rights on the Cloud project is stopped with Google's status only", async () => {
  cloudState(fake.state).deniedProjectUsers.add(ADMIN);

  const run = setup({});

  assert.equal(await runGoogleSetupSteps(run.input), false);

  const failed = run.events.find(
    (event) => event.type === "step" && event.status === "failed",
  );

  assert.equal(failed?.type === "step" && failed.id, "apis");
  assert.equal(failed?.type === "step" && failed.providerStatus, 403);
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

  assert.equal(await runGoogleSetupSteps(run.input), false);
  assert.equal(outcomeOf(run.events, "drive"), "skipped");
  assert.deepEqual(outcomes(run.events).at(-1), ["tests", "failed"]);
  assert.match(stepOf(run.events, "tests")?.hint ?? "", /few minutes/);
});

test("a run that runs out of time stops between steps and says which were not run", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });

  let elapsed = 0;
  const wait = (ms: number) => {
    elapsed += ms;
    t.mock.timers.tick(ms);
  };
  // Every Google call takes 15 seconds, the longest a request is let run.
  const run = setup(
    {},
    {
      fetchImpl: async (url, init) => {
        wait(15_000);
        return fetch(url, init);
      },
      sleep: async (ms) => wait(ms),
    },
  );

  assert.equal(await runGoogleSetupSteps(run.input), false);
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

  assert.equal(await runGoogleSetupSteps(run.input), false);
  // The revoke after it can take one more request of 15 seconds, and all
  // of it has to fit in the route's 300.
  assert.ok(elapsed + 15_000 <= 300_000, `ran for ${String(elapsed / 1000)} s`);
  assert.ok(refusalOf(run.events).includes(SETUP_STEP_TITLES.tests));
  assert.equal(outcomeOf(run.events, "tests"), undefined);
});

test("a progress report that cannot be sent does not stop the setup", async () => {
  const stored: WorkspaceSettings = {};
  const run = setup(stored, {
    emit: () => {
      throw new TypeError("Invalid state: Controller is already closed");
    },
  });

  assert.equal(await runGoogleSetupSteps(run.input), true);
  assert.ok(stored["google.pickerApiKey"]);
  assert.equal(stored["directory.enabled"], "on");
  assert.deepEqual(run.tested, [stored["files.exportDestination"]]);
});

test("a directory turned off on purpose stays off", async () => {
  const stored: WorkspaceSettings = { "directory.enabled": "off" };

  await runGoogleSetupSteps(setup(stored).input);
  assert.equal(stored["directory.enabled"], "off");
});

test("a Shared Drive someone else made with the same name is not taken over", async () => {
  fake.addDrive({ id: "0AFakeLookalike", name: "BusbarSigner Executed" });

  const stored: WorkspaceSettings = {};

  assert.equal(await runGoogleSetupSteps(setup(stored).input), true);

  const driveId = stored["files.exportDestination"] ?? "";

  assert.notEqual(driveId, "0AFakeLookalike");
  assert.deepEqual(
    serviceAccountMembers("0AFakeLookalike", FAKE_SERVICE_ACCOUNT_EMAIL),
    [],
  );
  assert.equal(
    serviceAccountMembers(driveId, FAKE_SERVICE_ACCOUNT_EMAIL).length,
    1,
  );
});

test("a long app name still makes a Picker key within Google's 63 characters", async () => {
  for (const length of [1, 56, 57, 60, 120]) {
    assert.ok(pickerKeyName("A".repeat(length)).length <= 63, String(length));
  }

  const appName = "A".repeat(60);
  const stored: WorkspaceSettings = {};
  const first = setup(stored, { appName });

  await runGoogleSetupSteps(first.input);
  assert.equal(outcomeOf(first.events, "picker"), "done");

  const second = setup(stored, { appName });

  await runGoogleSetupSteps(second.input);
  assert.equal(outcomeOf(second.events, "picker"), "skipped");
  assert.equal(cloudState(fake.state).apiKeys.size, 1);
});

test("values set where the site runs are kept and the Shared Drive there is the one tested", async () => {
  fake.addDrive({ id: "0AFakeFromEnv", name: "Contracts" });

  const stored: WorkspaceSettings = {
    "files.exportDestination": "0AFakeOldStored",
  };
  const run = setup(stored, {
    env: {
      ...fake.env,
      GOOGLE_PICKER_API_KEY: "AIzaFromEnvironment000000000",
      GOOGLE_WORKSPACE_CUSTOMER_ID: "C0env",
      WORKSPACE_EXPORT_DESTINATION: "0AFakeFromEnv",
    },
  });

  await runGoogleSetupSteps(run.input);
  assert.equal(outcomeOf(run.events, "picker"), "skipped");
  assert.equal(outcomeOf(run.events, "customer"), "skipped");
  assert.equal(outcomeOf(run.events, "drive"), "skipped");
  assert.deepEqual(run.tested, ["0AFakeFromEnv"]);
  assert.equal(stored["google.pickerApiKey"], undefined);
  assert.equal(stored["google.customerId"], undefined);
});

test("a Picker key saved without the project number needs attention", async () => {
  cloudState(fake.state).hideProjectNumber = true;

  const stored: WorkspaceSettings = {};
  const run = setup(stored);

  assert.equal(await runGoogleSetupSteps(run.input), false);
  assert.equal(outcomeOf(run.events, "picker"), "failed");
  assert.ok(stored["google.pickerApiKey"], "the key is still saved");
  assert.equal(stored["google.pickerAppId"], undefined);
});

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

  const stored: WorkspaceSettings = {};
  const run = setup(stored);

  await runGoogleSetupSteps(run.input);
  assert.equal(outcomeOf(run.events, "picker"), "done");
  assert.equal(cloud.apiKeys.size, 301);
  assert.deepEqual(cloud.apiKeys.get(ours)?.restrictions, PICKER_RESTRICTIONS);
  assert.equal(stored["google.pickerApiKey"], "AIzaOurs");
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

  await runGoogleSetupSteps(run.input);
  assert.equal(outcomeOf(run.events, "role"), "done");
  assert.equal(cloud.roles.size, 101);
  assert.deepEqual(
    cloud.roleAssignments.map((item) => [item.roleId, item.assignedTo]),
    [["ours", fakeServiceAccountUniqueId(FAKE_SERVICE_ACCOUNT_EMAIL)]],
  );
});

test("the saved Shared Drive without the service account gets it added, and one that is gone is made again", async () => {
  fake.addDrive({ id: "0AFakeOurs", name: "BusbarSigner Executed" });

  const stored: WorkspaceSettings = { "files.exportDestination": "0AFakeOurs" };
  const run = setup(stored);

  await runGoogleSetupSteps(run.input);
  assert.equal(outcomeOf(run.events, "drive"), "done");
  assert.equal(stored["files.exportDestination"], "0AFakeOurs");
  assert.deepEqual(
    serviceAccountMembers("0AFakeOurs", FAKE_SERVICE_ACCOUNT_EMAIL).map(
      (member) => member.role,
    ),
    ["fileOrganizer"],
  );

  const gone: WorkspaceSettings = { "files.exportDestination": "0AFakeGone" };

  await runGoogleSetupSteps(setup(gone).input);
  assert.notEqual(gone["files.exportDestination"], "0AFakeGone");
  assert.equal(
    fake.state.drives.get(gone["files.exportDestination"] ?? "")?.name,
    "BusbarSigner Executed",
  );
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

  assert.equal(await runGoogleSetupSteps(run.input), true);
  assert.equal(outcomeOf(run.events, "picker"), "done");
  assert.equal(waits.filter((ms) => ms === 5000).length, 3);
});

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
  assert.ok(cloud.enabledServices.has("cloudresourcemanager.googleapis.com"));
});

test("an account that cannot list projects is told so in our words, and can still make one", async () => {
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
  assert.doesNotMatch(listed.problem ?? "", /The caller does not have/);
});

test("a new project is made in the organization, saved, and used for every step", async () => {
  const stored: WorkspaceSettings = {};
  const run = setup(stored, {
    project: {
      create: true,
      name: "BusbarSigner Workspace",
      parent: "organizations/555000111",
      projectId: "busbarsigner-ws-abc123",
    },
  });

  assert.equal(await runGoogleSetupSteps(run.input), true);

  const made = cloudState(fake.state).projects.get("busbarsigner-ws-abc123");

  assert.equal(made?.parent, "organizations/555000111");
  assert.equal(stored["google.cloudProject"], "busbarsigner-ws-abc123");
  assert.equal(stored["google.pickerAppId"], made?.number);
  assert.ok(
    cloudState(fake.state).addonDeployments.has(
      `busbarsigner-ws-abc123/${DEFAULT_DEPLOYMENT_ID}`,
    ),
  );
});

// The site's own identity, with nothing secret kept.

const noIdentity: GoogleSetupStepsInput["identity"] = {
  fixed: null,
  unreadable: null,
};

test("off Google Cloud the setup makes the site's service account, makes no key, and says how to give it to the site", async () => {
  const stored: WorkspaceSettings = {};
  const run = setup(stored, { identity: noIdentity });

  // Not everything is done: the site still needs the account where it runs.
  assert.equal(await runGoogleSetupSteps(run.input), false);

  const cloud = cloudState(fake.state);
  const identity = stepOf(run.events, "identity");

  assert.equal(identity?.status, "action");
  assert.ok(cloud.serviceAccounts.has(OWN_ACCOUNT));
  assert.equal(cloud.keysMade.size, 0, "no key is made");
  assert.match(identity?.hint ?? "", /GOOGLE_SERVICE_ACCOUNT_KEY/);
  assert.match(
    identity?.hint ?? "",
    /-e GOOGLE_IMPERSONATE_SERVICE_ACCOUNT=busbarsigner-workspace@/,
  );
  assert.match(identity?.hint ?? "", /gcloud auth application-default login/);
  // Nothing secret, nor the account, is saved.
  assert.deepEqual(
    Object.keys(stored).filter(
      (key) =>
        /key|secret|impersonat/i.test(key) && key !== "google.pickerApiKey",
    ),
    [],
  );
  // The administrator may act as it, for organizations that forbid keys.
  assert.deepEqual(cloud.iamPolicies.get(OWN_ACCOUNT)?.bindings, [
    {
      members: [`user:${ADMIN}`],
      role: "roles/iam.serviceAccountTokenCreator",
    },
  ]);
  // The directory role and the Shared Drive go to the new account.
  assert.deepEqual(
    cloud.roleAssignments.map((item) => item.assignedTo),
    [fakeServiceAccountUniqueId(OWN_ACCOUNT)],
  );
  assert.equal(
    serviceAccountMembers(stored["files.exportDestination"] ?? "", OWN_ACCOUNT)
      .length,
    1,
  );
  // The checks wait until the site has the account.
  assert.equal(outcomeOf(run.events, "tests"), "action");
  assert.deepEqual(run.tested, []);

  // Run again: nothing is made twice.
  const again = setup(stored, { identity: noIdentity });

  await runGoogleSetupSteps(again.input);
  assert.equal(cloud.serviceAccounts.size, 1);
  assert.equal(
    cloud.iamPolicies.get(OWN_ACCOUNT)?.bindings[0]?.members.length,
    1,
  );
  assert.equal(cloud.roleAssignments.length, 1);
  assert.equal(cloud.keysMade.size, 0);
});

test("the account's IAM policy is read as version 3 and written again after a conflict", async () => {
  const cloud = cloudState(fake.state);

  cloud.iamEtagConflicts = 1;

  await runGoogleSetupSteps(setup({}, { identity: noIdentity }).input);
  assert.ok(cloud.requestedPolicyVersions.length >= 2);
  assert.ok(cloud.requestedPolicyVersions.every((version) => version === 3));
  assert.deepEqual(cloud.iamPolicies.get(OWN_ACCOUNT)?.bindings, [
    {
      members: [`user:${ADMIN}`],
      role: "roles/iam.serviceAccountTokenCreator",
    },
  ]);
});

test("the administrator's gcloud login can then impersonate the account the setup made", async () => {
  await runGoogleSetupSteps(setup({}, { identity: noIdentity }).input);

  const adc = JSON.stringify({
    client_id: "fake-client-id.apps.googleusercontent.com",
    client_secret: "fake-client-secret",
    refresh_token: fake.issueRefreshToken({
      scopes: [GOOGLE_SCOPES.cloudPlatform],
      user: ADMIN,
    }),
    type: "authorized_user",
  });
  const env = {
    ...fake.env,
    GOOGLE_IMPERSONATE_SERVICE_ACCOUNT: OWN_ACCOUNT,
    HOME: "/home/node",
  };
  const credentials = createGoogleCredentials({
    env,
    readFile: (file) =>
      file === "/home/node/.config/gcloud/application_default_credentials.json"
        ? adc
        : null,
  });

  assert.equal(credentials?.source, "impersonation");

  const token = await credentials!.getAccessToken({
    scopes: [GOOGLE_SCOPES.drive],
  });

  assert.equal(fake.state.accessTokens.get(token)?.serviceAccount, OWN_ACCOUNT);
});

test("on Google Cloud the account the site runs as is used, and no account is made", async () => {
  const run = setup(
    {},
    {
      identity: {
        fixed: { email: FAKE_SERVICE_ACCOUNT_EMAIL, source: "metadata" },
        unreadable: null,
      },
    },
  );

  assert.equal(await runGoogleSetupSteps(run.input), true);
  assert.match(
    stepOf(run.events, "identity")?.detail ?? "",
    /Runs on Google Cloud as signudoc@fake-project/,
  );
  assert.equal(cloudState(fake.state).serviceAccounts.size, 0);
});

test("an identity set where the site runs that cannot be read is reported, and no account is made", async () => {
  const configured = "app@other-project.iam.gserviceaccount.com";
  const run = setup(
    {},
    {
      identity: {
        fixed: null,
        unreadable: {
          email: configured,
          problem:
            "GOOGLE_IMPERSONATE_SERVICE_ACCOUNT is set, but no gcloud application-default login is mounted into the container.",
        },
      },
    },
  );

  assert.equal(await runGoogleSetupSteps(run.input), false);
  assert.equal(outcomeOf(run.events, "identity"), "failed");
  assert.equal(cloudState(fake.state).serviceAccounts.size, 0);
  // The rest of the setup uses the account the environment names.
  assert.deepEqual(
    cloudState(fake.state).roleAssignments.map((item) => item.assignedTo),
    [fakeServiceAccountUniqueId(configured)],
  );
});

// The add-on.

type Deployed = {
  addOns?: { common?: { homepageTrigger?: { runFunction?: string } } };
};

test("the add-on is deployed, installed for the administrator, and updated when the site moves", async () => {
  const stored: WorkspaceSettings = {};
  const cloud = cloudState(fake.state);
  const key = `fake-project/${DEFAULT_DEPLOYMENT_ID}`;
  const first = setup(stored);

  assert.equal(await runGoogleSetupSteps(first.input), true);
  assert.equal(outcomeOf(first.events, "addon"), "done");
  assert.ok(cloud.addonInstalls.has(`${key}/${ADMIN}`));
  assert.equal(
    stored["google.addonServiceAccount"],
    "service-123456789012@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
  );
  assert.equal(stored["google.addonClientId"], "1123456789012");
  assert.equal(
    (cloud.addonDeployments.get(key)?.deployment as Deployed).addOns?.common
      ?.homepageTrigger?.runFunction,
    `${SITE}/api/workspace/add-in/homepage`,
  );

  const moved = setup(stored, {
    addon: {
      deployment: buildAddonDeployment({
        siteUrl: "https://sign2.example.test",
      }),
    },
  });

  await runGoogleSetupSteps(moved.input);
  assert.equal(outcomeOf(moved.events, "addon"), "done");
  assert.equal(
    (cloud.addonDeployments.get(key)?.deployment as Deployed).addOns?.common
      ?.homepageTrigger?.runFunction,
    "https://sign2.example.test/api/workspace/add-in/homepage",
  );
  assert.equal(cloud.addonDeployments.size, 1);
});

test("without a public HTTPS address the add-on is skipped and says why", async () => {
  const problem = addInAddressProblem("http://localhost:8080");

  assert.ok(problem);

  const run = setup({}, { addon: { skipped: problem } });

  assert.equal(await runGoogleSetupSteps(run.input), true);
  assert.equal(outcomeOf(run.events, "addon"), "skipped");
  assert.equal(cloudState(fake.state).addonDeployments.size, 0);
});
