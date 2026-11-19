import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import type pg from "pg";

import { replaceDbPoolForTests } from "../db/connection.ts";
import { openTestDatabase } from "../db/test-database.ts";
import {
  getIntegrationSettings,
  invalidateIntegrationSettingsCache,
  readIntegrationSettings,
} from "../integration-settings.ts";
import { markOnboardingStep } from "./steps.ts";

// A mark saved on the onboarding checklist is merged into what is stored
// at the time, not into what this process last read, so marks saved on
// another instance are not lost. Run with `npm run test:db`.

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

test("a mark saved elsewhere is kept when another is saved from a stale read", async () => {
  // This process has read the settings, and they hold no marks.
  assert.equal(
    (await getIntegrationSettings(env))["onboarding.steps"],
    undefined,
  );

  // Another instance saves a mark.
  await database.query(
    `
      insert into public.integration_settings (key, value, secret, updated_at, updated_by)
      values ('onboarding.steps', $1, false, 0, null)
    `,
    [JSON.stringify({ retention: "skipped" })],
  );

  await markOnboardingStep("notifications", "skipped", actor, env);

  const stored = await readIntegrationSettings(database, env);

  assert.deepEqual(JSON.parse(stored["onboarding.steps"] ?? "{}"), {
    notifications: "skipped",
    retention: "skipped",
  });
});
