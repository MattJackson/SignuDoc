import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type pg from "pg";

import {
  AccountMutationError,
  BREAK_GLASS_CLOSURE_MESSAGE,
  LAST_ADMIN_CLOSURE_MESSAGE,
  accountClosureBlock,
  requestAccountClosure,
} from "./account.ts";
import { openTestDatabase } from "./db/test-database.ts";

// Closing an account from Settings, Danger zone, is refused for the last
// administrator and for the break-glass account (the addresses kept for
// password sign-in, and the account first-run setup made). Each test runs
// in a transaction that is rolled back, so the administrators other tests
// leave behind can be set aside. Run with `npm run test:db`.

const env = { BETTER_AUTH_SECRET: "a".repeat(40), EMAIL_DRIVER: "capture" };
const confirmation = { confirmation: "close my account" };

let database: pg.Pool;

before(async () => {
  database = await openTestDatabase();
});

after(async () => {
  await database.end();
});

async function inRolledBackTransaction(
  run: (client: pg.PoolClient) => Promise<void>,
) {
  const client = await database.connect();

  try {
    await client.query("BEGIN");
    // Nobody else is an administrator, unless a test makes one.
    await client.query(
      `update public."user" set role = 'user' where role = 'admin'`,
    );
    await client.query(`delete from public.integration_settings`);
    await run(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function createUser(
  client: pg.PoolClient,
  role: "admin" | "user",
): Promise<{ email: string; id: string }> {
  const id = randomUUID();
  const email = `${id}@example.test`;

  await client.query(
    `
      insert into public."user" (id, name, email, role, "emailVerified")
      values ($1, $2, $3, $4, true)
    `,
    [id, `Person ${id.slice(0, 4)}`, email, role],
  );

  return { email, id };
}

function refusedWith(message: string) {
  return (error: unknown) =>
    error instanceof AccountMutationError &&
    error.statusCode === 409 &&
    error.message === message;
}

test("the last administrator cannot close their account", async () => {
  await inRolledBackTransaction(async (client) => {
    const admin = await createUser(client, "admin");

    assert.equal(
      await accountClosureBlock(admin, client, env),
      LAST_ADMIN_CLOSURE_MESSAGE,
    );
    await assert.rejects(
      requestAccountClosure(admin.id, confirmation, { database: client, env }),
      refusedWith(LAST_ADMIN_CLOSURE_MESSAGE),
    );

    const { rows } = await client.query(
      `select 1 from account_closure_requests where user_id = $1`,
      [admin.id],
    );

    assert.equal(rows.length, 0);
  });
});

test("an administrator can close their account once someone else is one", async () => {
  await inRolledBackTransaction(async (client) => {
    const admin = await createUser(client, "admin");
    const other = await createUser(client, "admin");

    assert.equal(await accountClosureBlock(admin, client, env), null);

    // Once that administrator has asked to close, the one left is the last.
    await client.query(
      `
        insert into account_closure_requests
          (user_id, requested_at, export_expires_at, purge_after_at, updated_at)
        values ($1, 1, 2, 3, 1)
      `,
      [admin.id],
    );

    assert.equal(
      await accountClosureBlock(other, client, env),
      LAST_ADMIN_CLOSURE_MESSAGE,
    );
  });
});

test("a break-glass address cannot be closed", async () => {
  await inRolledBackTransaction(async (client) => {
    await createUser(client, "admin");

    const person = await createUser(client, "user");

    await client.query(
      `
        insert into public.integration_settings (key, value, secret, updated_at, updated_by)
        values ('sso.passwordAllowedEmails', $1, false, 0, null)
      `,
      [person.email.toUpperCase()],
    );

    await assert.rejects(
      requestAccountClosure(person.id, confirmation, {
        database: client,
        env,
      }),
      refusedWith(BREAK_GLASS_CLOSURE_MESSAGE),
    );
  });
});

test("the account first-run setup made cannot be closed", async () => {
  await inRolledBackTransaction(async (client) => {
    await createUser(client, "admin");

    const installer = await createUser(client, "admin");

    await client.query(
      `
        insert into public.app_settings (id, signup_mode, created_at, updated_at)
        values (true, 'closed', 0, 0)
        on conflict (id) do nothing
      `,
    );
    await client.query(
      `update public.app_settings set installer_user_id = $1 where id`,
      [installer.id],
    );

    await assert.rejects(
      requestAccountClosure(installer.id, confirmation, {
        database: client,
        env,
      }),
      refusedWith(BREAK_GLASS_CLOSURE_MESSAGE),
    );
  });
});

test("the hosted service lets anyone close their account", async () => {
  await inRolledBackTransaction(async (client) => {
    const admin = await createUser(client, "admin");

    assert.equal(
      await accountClosureBlock(admin, client, { ...env, HOSTED_MODE: "1" }),
      null,
    );
  });
});
