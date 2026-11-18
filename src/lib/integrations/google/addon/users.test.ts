import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveWorkspaceDomains } from "../../../auth/sso.ts";
import type { DbExecutor } from "../../../db/connection.ts";
import { findAddonUser, isEmailInWorkspace } from "./users.ts";

// From the address in Google's user ID token to a SignuDoc account, with a
// stand-in for the database that answers the one query.

type Row = { email: string; emailVerified: boolean; id: string; name: string };

function fakeDatabase(rows: Row[]) {
  const asked: unknown[][] = [];
  const database = {
    query: async (_text: string, values: unknown[]) => {
      asked.push(values);

      return {
        rows: rows.filter((row) => row.email.toLowerCase() === values[0]),
      };
    },
  } as unknown as DbExecutor;

  return { asked, database };
}

test("an address is in the Workspace when its domain is one of them", () => {
  assert.equal(isEmailInWorkspace("sam@example.com", ["example.com"]), true);
  assert.equal(isEmailInWorkspace("sam@other.example", ["example.com"]), false);
  assert.equal(isEmailInWorkspace("sam@other.example", []), true);
  assert.equal(isEmailInWorkspace("not-an-address", []), false);
});

test("the account with that address is found, whatever its case", async () => {
  const { asked, database } = fakeDatabase([
    { email: "Sam@Example.com", emailVerified: true, id: "u-1", name: "" },
  ]);
  const lookup = await findAddonUser(
    { email: "SAM@example.com" },
    ["example.com"],
    database,
  );

  assert.deepEqual(lookup, {
    kind: "found",
    // With no name saved, the address stands in for one.
    user: { email: "Sam@Example.com", id: "u-1", name: "Sam@Example.com" },
  });
  assert.deepEqual(asked, [["sam@example.com"]]);
});

test("no account, an unverified one, or another domain is not a match", async () => {
  const { asked, database } = fakeDatabase([
    { email: "new@example.com", emailVerified: false, id: "u-2", name: "New" },
    { email: "sam@other.example", emailVerified: true, id: "u-3", name: "Sam" },
  ]);

  assert.deepEqual(
    await findAddonUser(
      { email: "nobody@example.com" },
      ["example.com"],
      database,
    ),
    { kind: "no_account" },
  );
  assert.deepEqual(
    await findAddonUser(
      { email: "new@example.com" },
      ["example.com"],
      database,
    ),
    { kind: "unverified" },
  );
  assert.deepEqual(
    await findAddonUser(
      { email: "sam@other.example" },
      ["example.com"],
      database,
    ),
    { kind: "outside_workspace" },
  );
  // The last was refused before the database was asked.
  assert.equal(asked.length, 2);
});

test("an invalid Workspace domain list lets no address in", async () => {
  const invalid = resolveWorkspaceDomains({
    env: { GOOGLE_WORKSPACE_DOMAINS: "acme" },
    signupDomains: [],
    stored: null,
  });

  assert.equal(isEmailInWorkspace("sam@example.com", invalid), false);
});
