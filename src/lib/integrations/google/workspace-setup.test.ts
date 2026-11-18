import assert from "node:assert/strict";
import { after, before, test } from "node:test";

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
  runWorkspaceSetup,
  sealSetupState,
  setupScopes,
  SETUP_APIS,
  type SetupEvent,
  type WorkspaceSetupInput,
} from "./workspace-setup.ts";

// The automatic Google Workspace setup against the fake Google server:
// every step, run once and then again (when nothing is left to do), and
// the refusals.

const ADMIN = "ada@example.test";
const NOT_ADMIN = "bob@example.test";

let fake: FakeGoogle;

before(async () => {
  fake = await startFakeGoogle({
    users: [
      { email: ADMIN, familyName: "Admin", givenName: "Ada", isAdmin: true },
      { email: NOT_ADMIN, familyName: "User", givenName: "Bob" },
    ],
  });
});

after(async () => {
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
  assert.deepEqual(key?.restrictions, {
    apiTargets: [{ service: "picker.googleapis.com" }],
    browserKeyRestrictions: {
      allowedReferrers: ["https://sign.example.test/*"],
    },
  });
  assert.equal(stored["drive.pickerApiKey"], key?.keyString);
  assert.equal(stored["drive.appId"], cloud.projectNumber);
  assert.equal(stored["google.customerId"], cloud.customerId);
  assert.equal(stored["google.directory"], "on");

  const [role] = Array.from(cloud.roles.values());

  assert.equal(role?.roleName, "BusbarSigner directory reader");
  assert.deepEqual(role?.rolePrivileges, [
    { privilegeName: "USERS_RETRIEVE", serviceId: FAKE_ADMIN_SERVICE_ID },
    { privilegeName: "GROUPS_RETRIEVE", serviceId: FAKE_ADMIN_SERVICE_ID },
  ]);
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

  const refused = run.events.find((event) => event.type === "refused");

  assert.match(
    refused?.type === "refused" ? refused.message : "",
    /not a Workspace super admin/,
  );
  assert.deepEqual(outcomes(run.events), [["apis", "skipped"]]);
});

test("an account with no rights on the Cloud project is stopped at the first step", async () => {
  const cloud = cloudState(fake.state);

  cloud.deniedProjectUsers.add(ADMIN);

  try {
    const run = setup({});

    assert.equal(await runWorkspaceSetup(run.input), false);

    const failed = run.events.find(
      (event) => event.type === "step" && event.status === "failed",
    );

    assert.equal(failed?.type === "step" && failed.id, "apis");
    assert.equal(failed?.type === "step" && failed.googleStatus, 403);
    assert.match(failed?.type === "step" ? (failed.hint ?? "") : "", /Owner/);
  } finally {
    cloud.deniedProjectUsers.delete(ADMIN);
  }
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
