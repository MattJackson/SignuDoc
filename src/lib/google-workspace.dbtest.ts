import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import type pg from "pg";

import { replaceDbPoolForTests } from "./db/connection.ts";
import { openTestDatabase } from "./db/test-database.ts";
import {
  GoogleWorkspaceSettingsError,
  saveGoogleWorkspaceSettings,
} from "./google-workspace.ts";
import {
  getIntegrationSettings,
  invalidateIntegrationSettingsCache,
  saveIntegrationSettings,
} from "./integration-settings.ts";

// The checks made before password sign-in is turned off, against a real
// Postgres: the saved settings are judged as they will be after the save,
// so clearing the break-glass list or the client secret in the same save
// (or later on its own) is refused. Run with `npm run test:db`.

const env = { BETTER_AUTH_SECRET: "a".repeat(40) };
const actor = { email: "admin@example.test", id: "admin-1" };

let database: pg.Pool;
let replaced: pg.Pool | null = null;

before(async () => {
  database = await openTestDatabase();
  replaced = replaceDbPoolForTests(database);
});

beforeEach(async () => {
  await database.query(`delete from public.integration_settings`);
  invalidateIntegrationSettingsCache();
});

after(async () => {
  await database.query(`delete from public.integration_settings`);

  if (replaced) {
    replaceDbPoolForTests(replaced);
  }

  await database.end();
});

async function seedWorkingSso(passwordOff: boolean) {
  await saveIntegrationSettings(
    {
      "sso.clientId": "client-id",
      "sso.clientSecret": "client-secret",
      "sso.issuer": "https://accounts.google.com",
      "sso.passwordAllowedEmails": "admin@x.com",
      ...(passwordOff ? { "sso.passwordSignIn": "off" as const } : {}),
    },
    actor,
    { area: "test", database, env },
  );
}

async function fieldErrorsOf(input: unknown) {
  try {
    await saveGoogleWorkspaceSettings(input, actor, env);
  } catch (error) {
    assert.ok(error instanceof GoogleWorkspaceSettingsError);

    return error.fieldErrors;
  }

  return null;
}

test("turning password sign-in off is refused when the same save clears the break-glass list", async () => {
  await seedWorkingSso(false);

  const errors = await fieldErrorsOf({
    passwordAllowedEmails: "",
    passwordSignIn: false,
  });

  assert.ok(errors?.passwordAllowedEmails, "the list is asked for");
  assert.equal(
    (await getIntegrationSettings(env))["sso.passwordSignIn"],
    undefined,
  );
});

test("turning password sign-in off is refused when the same save removes the client secret", async () => {
  await seedWorkingSso(false);

  const errors = await fieldErrorsOf({
    passwordSignIn: false,
    removeClientSecret: true,
  });

  assert.ok(errors?.passwordSignIn, "single sign-on would no longer work");
});

test("clearing the break-glass list on its own is refused while password sign-in is off", async () => {
  await seedWorkingSso(true);

  const errors = await fieldErrorsOf({ passwordAllowedEmails: "" });

  assert.ok(errors?.passwordAllowedEmails, "the list is kept");
  assert.equal(
    (await getIntegrationSettings(env))["sso.passwordAllowedEmails"],
    "admin@x.com",
  );
});

test("turning password sign-in off still works when single sign-on and the list are in place", async () => {
  await seedWorkingSso(false);

  assert.equal(await fieldErrorsOf({ passwordSignIn: false }), null);
  assert.equal(
    (await getIntegrationSettings(env))["sso.passwordSignIn"],
    "off",
  );
});
