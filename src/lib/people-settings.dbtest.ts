import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type pg from "pg";

import { replaceDbPoolForTests } from "./db/connection.ts";
import { openTestDatabase } from "./db/test-database.ts";
import { getPeopleSettingsView } from "./people-settings.ts";

// The people settings page against a real Postgres: a teams list that
// cannot be read is an error, not an empty list that makes a team-limited
// manager rule look like it covers everyone. Run with `npm run test:db`.

let database: pg.Pool;
let replaced: pg.Pool | null = null;

before(async () => {
  database = await openTestDatabase();
  replaced = replaceDbPoolForTests(database);
});

after(async () => {
  if (replaced) {
    replaceDbPoolForTests(replaced);
  }

  await database.end();
});

test("a failed teams query is an error, not a view with no teams", async () => {
  const failingTeams = new Proxy(database, {
    get(target, property) {
      if (property === "query") {
        return (text: unknown, ...rest: unknown[]) =>
          typeof text === "string" && /FROM teams/i.test(text)
            ? Promise.reject(new Error("connection reset"))
            : (target.query as unknown as (...args: unknown[]) => unknown).call(
                target,
                text,
                ...rest,
              );
      }

      const value = Reflect.get(target, property, target) as unknown;

      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });

  await assert.rejects(
    getPeopleSettingsView({ database: failingTeams, env: {} }),
    /connection reset/,
  );
});
