import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type pg from "pg";

import { openTestDatabase } from "../db/test-database.ts";
import { syncGoogleProfile } from "./google-profile.ts";

// Each Google sign-in brings the account's name and picture up to date.
// Run with `npm run test:db`.

let database: pg.Pool;
const createdUsers: string[] = [];

before(async () => {
  database = await openTestDatabase();
});

after(async () => {
  for (const id of createdUsers) {
    await database.query(`delete from public."user" where id = $1`, [id]);
  }

  await database.end();
});

async function createUser(name: string) {
  const id = randomUUID();
  const email = `${id}@Example.test`;

  createdUsers.push(id);
  await database.query(
    `
      insert into public."user" (id, name, email, role, "emailVerified")
      values ($1, $2, $3, 'user', true)
    `,
    [id, name, email],
  );

  return { email, id };
}

async function read(id: string) {
  const { rows } = await database.query<{ image: string | null; name: string }>(
    `select name, image from public."user" where id = $1`,
    [id],
  );

  return { image: rows[0]?.image ?? null, name: rows[0]?.name };
}

test("the name and picture follow Google at each sign-in", async () => {
  const person = await createUser("M J");
  const first = "https://lh3.googleusercontent.com/a/first=s96-c";
  const second = "https://lh3.googleusercontent.com/a/second=s96-c";

  assert.equal(
    await syncGoogleProfile(
      person.email.toUpperCase(),
      { name: "Matt Jackson", picture: first },
      database,
    ),
    true,
  );
  assert.deepEqual(await read(person.id), {
    image: first,
    name: "Matt Jackson",
  });

  // A claim Google left out, or a picture from elsewhere, changes nothing.
  await syncGoogleProfile(
    person.email,
    { picture: "https://evil.example/x.png" },
    database,
  );
  assert.deepEqual(await read(person.id), {
    image: first,
    name: "Matt Jackson",
  });

  await syncGoogleProfile(person.email, { picture: second }, database);
  assert.deepEqual(await read(person.id), {
    image: second,
    name: "Matt Jackson",
  });
});

test("an address with no account changes nothing", async () => {
  assert.equal(
    await syncGoogleProfile(
      "nobody@example.test",
      { name: "Nobody" },
      database,
    ),
    false,
  );
});
