import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type pg from "pg";

import { openTestDatabase } from "../db/test-database.ts";
import {
  getWorkspaceSettings,
  readWorkspaceSettings,
  saveWorkspaceSettings,
  WorkspaceSettingsError,
} from "./settings.ts";

// The workspace settings against a real Postgres: a save writes and
// removes rows, records what changed in the install's audit trail, and a
// save that changes nothing records nothing. Run with `npm run test:db`.

let database: pg.Pool;
const actor = { email: "admin@acme.example", id: "workspace-settings-admin" };

async function auditRows(): Promise<Array<{ metadata: unknown }>> {
  const result = await database.query(
    `
      select metadata from public.system_audit_events
      where actor_user_id = $1 and event = 'settings_changed'
      order by sequence
    `,
    [actor.id],
  );

  return result.rows as Array<{ metadata: unknown }>;
}

before(async () => {
  database = await openTestDatabase();
  await database.query("delete from public.workspace_settings");
});

after(async () => {
  await database.query("delete from public.workspace_settings");
  await database.end();
});

test("a save writes, changes and removes settings, and is audited", async () => {
  const before = (await auditRows()).length;

  assert.deepEqual(await readWorkspaceSettings(database), {});
  assert.deepEqual(
    await saveWorkspaceSettings(
      { "workspace.provider": " google " },
      actor,
      database,
    ),
    ["workspace.provider"],
  );
  assert.deepEqual(await readWorkspaceSettings(database), {
    "workspace.provider": "google",
  });
  // The cache was cleared by the save.
  assert.deepEqual(await getWorkspaceSettings(database), {
    "workspace.provider": "google",
  });

  // The same value again changes nothing and records nothing.
  assert.deepEqual(
    await saveWorkspaceSettings(
      { "workspace.provider": "google" },
      actor,
      database,
    ),
    [],
  );

  // Null, or an empty value, removes it.
  assert.deepEqual(
    await saveWorkspaceSettings({ "workspace.provider": "" }, actor, database),
    ["workspace.provider"],
  );
  assert.deepEqual(await readWorkspaceSettings(database), {});

  const rows = (await auditRows()).slice(before);

  assert.deepEqual(
    rows.map((row) => row.metadata),
    [
      { workspace: { "workspace.provider": { from: null, to: "google" } } },
      { workspace: { "workspace.provider": { from: "google", to: null } } },
    ],
  );
});

test("an unknown key is refused before anything is written", async () => {
  await assert.rejects(
    saveWorkspaceSettings(
      { "google.serviceAccountKey": "secret" } as never,
      actor,
      database,
    ),
    WorkspaceSettingsError,
  );
  assert.deepEqual(await readWorkspaceSettings(database), {});
});
