import assert from "node:assert/strict";
import { test } from "node:test";

import type { Pool } from "pg";

import { replaceDbPoolForTests } from "./db/connection.ts";
import { getSettings, invalidateSettingsCache } from "./settings.ts";

// The settings cache must not take back a row that was read before it was
// cleared. The database is a stand-in whose first read is held until the
// test lets it finish.

function settingsRow(requireTwoFactor: boolean) {
  return {
    allowed_email_domains: [],
    require_two_factor: requireTwoFactor,
    signup_mode: "open",
  };
}

test("a read that began before a clear does not refill the cache", async () => {
  let release: (() => void) | undefined;
  let current = settingsRow(false);
  let calls = 0;
  const stub = {
    query: async () => {
      calls += 1;

      if (calls === 1) {
        // The read that straddles the clear: it sees the old row.
        const seen = current;

        await new Promise<void>((resolve) => {
          release = resolve;
        });

        return { rows: [seen] };
      }

      return { rows: [current] };
    },
  };
  const replaced = replaceDbPoolForTests(stub as unknown as Pool);

  try {
    invalidateSettingsCache();

    const held = getSettings({});

    // The save commits and clears the cache while the read is outstanding.
    current = settingsRow(true);
    invalidateSettingsCache();
    release?.();

    assert.equal((await held).requireTwoFactor, false);
    // Without the generation check the held read has stored the old row, and
    // this returns it from the cache instead of reading the new one.
    assert.equal((await getSettings({})).requireTwoFactor, true);
  } finally {
    replaceDbPoolForTests(replaced as unknown as Pool);
    invalidateSettingsCache();
  }
});
