import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type { WorkspaceSettings } from "../../settings.ts";
import { createGoogleCredentials } from "./credentials.ts";
import { googleDirectoryFor } from "./directory.ts";
import { googleWorkspace } from "./index.ts";
import { createGoogleSetup } from "./setup.ts";
import {
  createFakeServiceAccountKey,
  startFakeGoogle,
  type FakeGoogle,
} from "./test-support/fake-google.ts";

// The Google identity, the directory and their checks, against the fake
// Google server: the identity check gets a real token exchange, a broken
// identity is reported, not thrown, and the directory is there only once it
// is turned on.

const key = createFakeServiceAccountKey();
let google: FakeGoogle;

before(async () => {
  google = await startFakeGoogle({
    directoryDomains: ["acme.example"],
    groups: [
      {
        email: "signudoc-admins@acme.example",
        members: ["dana@acme.example"],
        name: "SignuDoc admins",
      },
    ],
    serviceAccounts: [key],
    users: [
      { email: "dana@acme.example", familyName: "Admin", givenName: "Dana" },
      { email: "sam@acme.example", familyName: "Sender", givenName: "Sam" },
    ],
  });
});

after(async () => {
  await google.close();
});

test("with a service account key, the identity is named and checked", async () => {
  const env = {
    ...google.env,
    GOOGLE_SERVICE_ACCOUNT_KEY: JSON.stringify(key),
  };
  const setup = createGoogleSetup({ env });
  const identity = await setup.identity();

  assert.equal(identity.configured, true);
  assert.equal(identity.account, key.client_email);
  assert.match(identity.description, /GOOGLE_SERVICE_ACCOUNT_KEY/);
  assert.deepEqual(
    (await setup.check("identity")).map((check) => check.ok),
    [true],
  );
});

test("a key Google does not accept fails the check with the status only", async () => {
  const other = createFakeServiceAccountKey(key.client_email);
  const setup = createGoogleSetup({
    getCredentials: () =>
      createGoogleCredentials({
        env: {
          ...google.env,
          GOOGLE_SERVICE_ACCOUNT_KEY: JSON.stringify(other),
        },
      }),
  });
  const [check] = await setup.check("identity");

  assert.equal(check?.ok, false);
  assert.match(check?.message ?? "", /failed with \d{3}/);
});

test("a key that does not parse is reported as the identity", async () => {
  const setup = createGoogleSetup({
    env: { GOOGLE_SERVICE_ACCOUNT_KEY: "not a key" },
  });
  const identity = await setup.identity();

  assert.equal(identity.configured, false);
  assert.match(identity.description, /not a service account key/);
  assert.equal((await setup.check("identity"))[0]?.ok, false);
});

// The directory parts, against the small Workspace in the fake.

function keyEnv() {
  return { ...google.env, GOOGLE_SERVICE_ACCOUNT_KEY: JSON.stringify(key) };
}

function setupWith(settings: WorkspaceSettings) {
  return createGoogleSetup({ env: keyEnv(), settings });
}

test("the directory is null until it is turned on", async () => {
  assert.equal(googleDirectoryFor({ env: keyEnv(), settings: {} }), null);
  assert.equal(
    googleDirectoryFor({
      env: keyEnv(),
      settings: { "directory.enabled": "off" },
    }),
    null,
  );

  const directory = googleWorkspace.directory?.({
    env: keyEnv(),
    settings: { "directory.enabled": "on" },
  });

  assert.ok(directory);
  assert.deepEqual(await directory.searchPeople("sam"), [
    { email: "sam@acme.example", name: "Sam Sender" },
  ]);
  assert.equal(
    await directory.isGroupMember(
      "signudoc-admins@acme.example",
      "dana@acme.example",
    ),
    true,
  );
});

test("without a Google identity there is no directory", async () => {
  const settings = { "directory.enabled": "on" };

  assert.equal(googleDirectoryFor({ env: {}, settings }), null);
  assert.equal(
    (await createGoogleSetup({ env: {}, settings }).check("directory"))[0]?.ok,
    false,
  );
});

test("the directory test finds the administrator, even before it is on", async () => {
  const [found] = await setupWith({}).check("directory", {
    email: "dana@acme.example",
  });

  assert.equal(found?.ok, true);
  assert.match(found?.message ?? "", /Dana Admin <dana@acme\.example>/);
  assert.match(found?.message ?? "", /not turned on yet/);

  const [missing] = await setupWith({}).check("directory", {
    email: "nobody@acme.example",
  });

  assert.equal(missing?.ok, false);
  assert.match(missing?.message ?? "", /Customer ID/);
});

test("the administrator group test says whether the administrator is in it", async () => {
  const settings = { "directory.adminGroup": "signudoc-admins@acme.example" };
  const [member] = await setupWith(settings).check("adminGroup", {
    email: "dana@acme.example",
  });

  assert.equal(member?.ok, true);
  assert.match(
    member?.message ?? "",
    /You are in signudoc-admins@acme\.example/,
  );

  const [outsider] = await setupWith(settings).check("adminGroup", {
    email: "sam@acme.example",
  });

  assert.equal(outsider?.ok, false);
  assert.match(outsider?.message ?? "", /You are not in/);

  const [unset] = await setupWith({}).check("adminGroup", {
    email: "dana@acme.example",
  });

  assert.equal(unset?.ok, false);
  assert.match(unset?.message ?? "", /No administrator group/);
});

test("a malformed service account key is reported by the directory and group tests", async () => {
  const env = { GOOGLE_SERVICE_ACCOUNT_KEY: "{not json" };
  const settings = {
    "directory.adminGroup": "admins@example.test",
    "directory.enabled": "on",
  };
  const provider = createGoogleSetup({ env, settings });

  assert.equal(googleDirectoryFor({ env, settings }), null);

  for (const feature of ["directory", "adminGroup"] as const) {
    const [check] = await provider.check(feature, {
      email: "admin@example.test",
    });

    assert.equal(check?.ok, false);
    assert.match(check?.message ?? "", /GOOGLE_SERVICE_ACCOUNT_KEY/);
  }
});
