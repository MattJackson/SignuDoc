import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createGoogleCredentials } from "./credentials.ts";
import { createGoogleSetup } from "./setup.ts";
import {
  createFakeServiceAccountKey,
  startFakeGoogle,
  type FakeGoogle,
} from "./test-support/fake-google.ts";

// The Google identity and its check, against the fake Google server: the
// identity check gets a real token exchange, and a broken identity is
// reported, not thrown.

const key = createFakeServiceAccountKey();
let google: FakeGoogle;

before(async () => {
  google = await startFakeGoogle({ serviceAccounts: [key] });
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
