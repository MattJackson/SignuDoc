import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import type pg from "pg";

import { replaceDbPoolForTests } from "./db/connection.ts";
import { openTestDatabase } from "./db/test-database.ts";
import {
  getIntegrationSettings,
  invalidateIntegrationSettingsCache,
  peekIntegrationSettings,
  readIntegrationSettings,
  saveIntegrationSettings,
} from "./integration-settings.ts";
import { ResendKeyError, saveResendApiKey } from "./resend-key.ts";
import { resolveResendApiKey } from "./services/email.ts";

// Settings saved in the app, against a real Postgres: secrets are stored
// encrypted and never written to the audit trail, the environment wins,
// and a stored secret the auth secret can no longer open counts as not
// set. Run with `npm run test:db`.

const env = { BETTER_AUTH_SECRET: "a".repeat(40) };
const actor = { email: "admin@example.test", id: "admin-1" };
const KEY = "re_storedkey1234567890";

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

async function lastSettingsEvent() {
  const result = await database.query<{ metadata: Record<string, unknown> }>(
    `
      select metadata from system_audit_events
      where event = 'settings_changed'
      order by sequence desc
      limit 1
    `,
  );

  return result.rows[0]?.metadata;
}

test("a secret is stored encrypted, read back, and kept out of the audit trail", async () => {
  await saveIntegrationSettings(
    { "resend.apiKey": KEY, "sso.issuer": "https://accounts.google.com" },
    actor,
    { area: "test", database, env },
  );

  const { rows } = await database.query<{
    key: string;
    secret: boolean;
    value: string;
  }>(`select key, value, secret from public.integration_settings order by key`);
  const stored = rows.find((row) => row.key === "resend.apiKey");

  assert.equal(stored?.secret, true);
  assert.notEqual(stored?.value, KEY);
  assert.doesNotMatch(stored?.value ?? "", /storedkey/);
  assert.equal(
    rows.find((row) => row.key === "sso.issuer")?.value,
    "https://accounts.google.com",
  );

  const settings = await readIntegrationSettings(database, env);

  assert.equal(settings["resend.apiKey"], KEY);

  const event = await lastSettingsEvent();

  assert.equal(event?.area, "test");
  assert.doesNotMatch(JSON.stringify(event), /storedkey/);
  assert.deepEqual(
    (event?.changes as Record<string, unknown>)["resend.apiKey"],
    { from: null, to: "set" },
  );
});

test("a secret the current auth secret cannot open counts as not set", async () => {
  await saveIntegrationSettings({ "sso.clientSecret": "shh" }, actor, {
    area: "test",
    database,
    env,
  });

  const other = await readIntegrationSettings(database, {
    BETTER_AUTH_SECRET: "b".repeat(40),
  });

  assert.equal(other["sso.clientSecret"], undefined);
});

test("saving the same value again changes nothing, and null removes it", async () => {
  await saveIntegrationSettings(
    { "google.adminGroup": "a@example.test" },
    actor,
    {
      area: "test",
      database,
      env,
    },
  );

  const earlier = await lastSettingsEvent();

  await saveIntegrationSettings(
    { "google.adminGroup": "a@example.test" },
    actor,
    {
      area: "other",
      database,
      env,
    },
  );
  assert.deepEqual(await lastSettingsEvent(), earlier);

  await saveIntegrationSettings({ "google.adminGroup": null }, actor, {
    area: "test",
    database,
    env,
  });
  assert.equal(
    (await readIntegrationSettings(database, env))["google.adminGroup"],
    undefined,
  );
});

test("a pasted Resend key is checked, kept, and RESEND_API_KEY wins", async () => {
  await assert.rejects(
    saveResendApiKey(KEY, actor, {
      check: async () => ({ message: "no", ok: false }),
      env,
    }),
    (error) => error instanceof ResendKeyError && error.statusCode === 400,
  );
  assert.equal(await resolveResendApiKey(env), null);

  const saved = await saveResendApiKey(KEY, actor, {
    check: async () => ({ access: "full", ok: true }),
    env,
  });

  assert.deepEqual(saved, { access: "full" });
  assert.deepEqual(await resolveResendApiKey(env), {
    key: KEY,
    source: "settings",
  });
  assert.deepEqual(
    await resolveResendApiKey({
      ...env,
      RESEND_API_KEY: "re_fromenvironment1",
    }),
    { key: "re_fromenvironment1", source: "env" },
  );

  await assert.rejects(
    saveResendApiKey(null, actor, {
      env: { ...env, RESEND_API_KEY: "re_fromenvironment1" },
    }),
    (error) => error instanceof ResendKeyError && error.statusCode === 409,
  );

  await saveResendApiKey(null, actor, { env });
  assert.equal(await resolveResendApiKey(env), null);
});

test("the last settings read are remembered for code that cannot wait", async () => {
  assert.equal(peekIntegrationSettings(), null);

  await saveIntegrationSettings({ "resend.apiKey": KEY }, actor, {
    area: "test",
    database,
    env,
  });
  // The instance that saved sees the change at once.
  assert.equal(peekIntegrationSettings()?.["resend.apiKey"], KEY);

  invalidateIntegrationSettingsCache();
  assert.equal(peekIntegrationSettings(), null);

  await getIntegrationSettings(env);
  assert.equal(peekIntegrationSettings()?.["resend.apiKey"], KEY);
});
