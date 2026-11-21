import assert from "node:assert/strict";
import { test } from "node:test";

import type { Pool } from "pg";

import { replaceDbPoolForTests } from "./db/connection.ts";
import {
  getIntegrationSettings,
  invalidateIntegrationSettingsCache,
} from "./integration-settings.ts";

// The integration settings cache must not take back values that were read
// before it was cleared. The database is a stand-in whose first read is held
// until the test lets it finish.

test("a read that began before a clear does not refill the cache", async () => {
  let release: (() => void) | undefined;
  let current = [{ key: "google.adminGroup", secret: false, value: "old" }];
  let calls = 0;
  const stub = {
    query: async () => {
      calls += 1;

      if (calls === 1) {
        const seen = current;

        await new Promise<void>((resolve) => {
          release = resolve;
        });

        return { rows: seen };
      }

      return { rows: current };
    },
  };
  const replaced = replaceDbPoolForTests(stub as unknown as Pool);

  try {
    invalidateIntegrationSettingsCache();

    const held = getIntegrationSettings({});

    current = [{ key: "google.adminGroup", secret: false, value: "new" }];
    invalidateIntegrationSettingsCache();
    release?.();

    assert.equal((await held)["google.adminGroup"], "old");
    // Without the generation check the held read has stored the old values,
    // and this returns them from the cache instead of reading the new ones.
    assert.equal(
      (await getIntegrationSettings({}))["google.adminGroup"],
      "new",
    );
  } finally {
    replaceDbPoolForTests(replaced as unknown as Pool);
    invalidateIntegrationSettingsCache();
  }
});
