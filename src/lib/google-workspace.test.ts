import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { testDirectoryAccess, testGroupLookup } from "./google-workspace.ts";

// The directory checks on the Google Workspace page answer with a result,
// never a rejection, whatever is wrong with the credentials.

let previousKey: string | undefined;

before(() => {
  previousKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  process.env.GOOGLE_SERVICE_ACCOUNT_KEY = "{not json";
  // The saved settings are already known, so no database is asked.
  globalThis.__signudocIntegrationSettings = {
    expiresAt: Date.now() + 60_000,
    value: {},
  };
});

after(() => {
  if (previousKey === undefined) {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  } else {
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = previousKey;
  }

  globalThis.__signudocIntegrationSettings = undefined;
});

test("a malformed service account key is reported by the directory test", async () => {
  const result = await testDirectoryAccess("admin@example.test", {});

  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.message : "", /GOOGLE_SERVICE_ACCOUNT_KEY/);
});

test("a malformed service account key is reported by the group test", async () => {
  const result = await testGroupLookup(
    "admin@example.test",
    "admins@example.test",
    {},
  );

  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.message : "", /GOOGLE_SERVICE_ACCOUNT_KEY/);
});
