import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type pg from "pg";

import { replaceDbPoolForTests } from "./db/connection.ts";
import { openTestDatabase } from "./db/test-database.ts";
import {
  normalizeGroupAddress,
  readAdminGroup,
  syncAdminRoleFromGroup,
} from "./google-admin-group.ts";
import {
  DirectoryError,
  type DirectoryClient,
} from "./integrations/google/directory.ts";

// The administrator group against a real Postgres: members become
// administrators at sign-in, people who left stop being one, the last
// administrator stays, and every change is in the site audit trail.
// Run with `npm run test:db`.

const GROUP = "signudoc-admins@example.test";

let database: pg.Pool;
let replaced: pg.Pool | null = null;
const createdUsers: string[] = [];
let administratorsBefore: string[] = [];

before(async () => {
  database = await openTestDatabase();
  replaced = replaceDbPoolForTests(database);

  const existing = await database.query<{ id: string }>(
    `update public."user" set role = 'user' where role = 'admin' returning id`,
  );

  administratorsBefore = existing.rows.map((row) => row.id);
});

after(async () => {
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.query(
    `update public."user" set role = 'admin' where id = any($1)`,
    [administratorsBefore],
  );

  if (replaced) {
    replaceDbPoolForTests(replaced);
  }

  await database.end();
});

async function createUser(role: "admin" | "user" = "user") {
  const id = randomUUID();
  const email = `${id}@example.test`;

  createdUsers.push(id);
  await database.query(
    `
      insert into public."user" (id, name, email, role, "emailVerified")
      values ($1, $2, $3, $4, true)
    `,
    [id, `Person ${id.slice(0, 4)}`, email, role],
  );

  return { email, id };
}

async function roleOf(userId: string) {
  const result = await database.query<{ role: string }>(
    `select role from public."user" where id = $1`,
    [userId],
  );

  return result.rows[0]?.role;
}

function directoryWith(members: Set<string>, fail = false): DirectoryClient {
  return {
    isGroupMember: async (group, email) => {
      assert.equal(group, GROUP);

      if (fail) {
        throw new DirectoryError(
          "Google's directory could not be reached.",
          null,
        );
      }

      return members.has(email);
    },
    listUserGroups: async () => [],
    searchUsers: async () => [],
  };
}

async function roleEventsFor(userId: string) {
  const result = await database.query<{
    actor_user_id: string | null;
    metadata: Record<string, unknown>;
  }>(
    `
      select actor_user_id, metadata from system_audit_events
      where event = 'role_changed' and target_user_id = $1
      order by sequence
    `,
    [userId],
  );

  return result.rows;
}

test("a group is named by its address, and the environment wins", () => {
  assert.equal(
    normalizeGroupAddress(" Admins@Example.com "),
    "admins@example.com",
  );
  assert.equal(normalizeGroupAddress("admins"), null);
  assert.equal(normalizeGroupAddress("a b@example.com"), null);
  assert.deepEqual(
    readAdminGroup(
      { GOOGLE_ADMIN_GROUP: "it@example.com" },
      { "google.adminGroup": "other@example.com" },
    ),
    { group: "it@example.com", source: "env" },
  );
  assert.deepEqual(
    readAdminGroup({}, { "google.adminGroup": "x@example.com" }),
    {
      group: "x@example.com",
      source: "settings",
    },
  );
  assert.deepEqual(readAdminGroup({}, null), { group: null, source: "none" });
});

test("members become administrators and people who left stop being one", async () => {
  const keeper = await createUser("admin");
  const member = await createUser();
  const leaver = await createUser("admin");
  const members = new Set([keeper.email, member.email]);
  const options = { directory: directoryWith(members), group: GROUP };

  const granted = await syncAdminRoleFromGroup(member, options);

  assert.equal(granted.status, "synced");
  assert.equal(await roleOf(member.id), "admin");

  const revoked = await syncAdminRoleFromGroup(leaver, options);

  assert.equal(revoked.status, "synced");
  assert.equal(await roleOf(leaver.id), "user");

  const [grantEvent] = await roleEventsFor(member.id);

  assert.equal(grantEvent?.actor_user_id, null);
  assert.equal(grantEvent?.metadata.group, GROUP);
  assert.equal(grantEvent?.metadata.source, "google_group");
  assert.equal(grantEvent?.metadata.to, "admin");

  const [revokeEvent] = await roleEventsFor(leaver.id);

  assert.equal(revokeEvent?.metadata.to, "user");

  // Signing in again with nothing changed writes nothing.
  await syncAdminRoleFromGroup(member, options);
  assert.equal((await roleEventsFor(member.id)).length, 1);

  // Leave only the keeper as an administrator for the next test.
  await database.query(`update public."user" set role = 'user' where id = $1`, [
    member.id,
  ]);
  await database.query(`update public."user" set role = 'user' where id = $1`, [
    keeper.id,
  ]);
});

test("the last administrator keeps the role whatever the group says", async () => {
  const last = await createUser("admin");

  const result = await syncAdminRoleFromGroup(last, {
    directory: directoryWith(new Set()),
    group: GROUP,
  });

  assert.equal(result.status, "synced");
  assert.ok(result.status === "synced" && !result.result.changed);
  assert.equal(
    result.status === "synced" &&
      !result.result.changed &&
      result.result.reason,
    "last_admin",
  );
  assert.equal(await roleOf(last.id), "admin");
});

test("a lookup that fails changes nothing", async () => {
  await createUser("admin");
  const admin = await createUser("admin");

  const result = await syncAdminRoleFromGroup(admin, {
    directory: directoryWith(new Set(), true),
    group: GROUP,
  });

  assert.deepEqual(result, { status: "lookup_failed" });
  assert.equal(await roleOf(admin.id), "admin");
});

test("nothing happens without a group or a directory", async () => {
  const person = await createUser();

  assert.deepEqual(
    await syncAdminRoleFromGroup(person, { directory: null, group: GROUP }),
    { status: "not_configured" },
  );
  assert.deepEqual(
    await syncAdminRoleFromGroup(person, {
      directory: directoryWith(new Set([person.email])),
      group: null,
    }),
    { status: "not_configured" },
  );
  assert.equal(await roleOf(person.id), "user");
});
