import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type pg from "pg";

import { openTestDatabase } from "../../../db/test-database.ts";
import { findAddonUser } from "./users.ts";

// The add-on's lookup of an account by the address in Google's token, run
// against a real database, so the query itself is proven on both backends
// (the unit test in users.test.ts answers it with a stand-in). Run with
// `npm run test:db`.

let database: pg.Pool;
const createdUsers: string[] = [];
const suffix = randomUUID().slice(0, 8);
const domain = `addon-${suffix}.example`;

before(async () => {
  database = await openTestDatabase();
});

after(async () => {
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();
});

async function createAccount(email: string, emailVerified: boolean) {
  const id = randomUUID();

  createdUsers.push(id);
  await database.query(
    `
      insert into public."user" (id, name, email, "emailVerified", role)
      values ($1, $2, $3, $4, 'user')
    `,
    [id, "Sam Sender", email, emailVerified],
  );

  return id;
}

test("the add-on finds the account by its address, whatever the case", async () => {
  const id = await createAccount(`sam@${domain}`, true);

  assert.deepEqual(
    await findAddonUser(
      { email: `Sam@${domain.toUpperCase()}` },
      [domain],
      database,
    ),
    {
      kind: "found",
      user: { email: `sam@${domain}`, id, name: "Sam Sender" },
    },
  );
});

test("an account whose address is not confirmed is not a match", async () => {
  await createAccount(`new@${domain}`, false);

  assert.deepEqual(
    await findAddonUser({ email: `new@${domain}` }, [domain], database),
    { kind: "unverified" },
  );
});

test("an address with no account is not a match", async () => {
  assert.deepEqual(
    await findAddonUser({ email: `nobody@${domain}` }, [domain], database),
    { kind: "no_account" },
  );
});
