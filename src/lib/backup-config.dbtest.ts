import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { after, before, beforeEach, test } from "node:test";

import type pg from "pg";

import type { BackupBlob, BackupStore } from "./backup.ts";
import {
  getBackupSetupStatus,
  listBackupRuns,
  readStoredBackupConfig,
  runConfiguredBackup,
  saveBackupConfig,
} from "./backup-config.ts";
import { openTestDatabase } from "./db/test-database.ts";
import { GcsRequestError } from "./services/storage/gcs.ts";

// The backup settings chosen in Settings and the record of each run,
// against a real Postgres. Run with `npm run test:db`.

let database: pg.Pool;

const env = { BETTER_AUTH_SECRET: "a-test-secret-that-is-long-enough-1234" };
const actor = { email: "pat@acme.com", userId: "user-pat" };

/** A store kept in memory. */
function memoryStore(failWith?: Error): BackupStore & {
  objects: Map<string, Buffer>;
} {
  const objects = new Map<string, Buffer>();

  return {
    async delete(pathnames) {
      for (const pathname of pathnames) {
        objects.delete(pathname);
      }
    },
    async get(pathname) {
      const found = objects.get(pathname);

      return found
        ? {
            contentType: "application/octet-stream",
            stream: new Blob([new Uint8Array(found)]).stream(),
          }
        : null;
    },
    async list({ prefix }) {
      const blobs: BackupBlob[] = [...objects]
        .filter(([pathname]) => !prefix || pathname.startsWith(prefix))
        .map(([pathname, body]) => ({
          pathname,
          size: body.length,
          uploadedAt: new Date(),
        }));

      return { blobs, hasMore: false };
    },
    objects,
    async put(pathname, body) {
      if (failWith) {
        throw failWith;
      }

      if (typeof body === "string" || Buffer.isBuffer(body)) {
        objects.set(pathname, Buffer.from(body));
        return;
      }

      const chunks: Buffer[] = [];
      const readable =
        body instanceof Readable
          ? body
          : Readable.fromWeb(body as import("node:stream/web").ReadableStream);

      for await (const chunk of readable) {
        chunks.push(Buffer.from(chunk as Uint8Array));
      }

      objects.set(pathname, Buffer.concat(chunks));
    },
  };
}

async function clearTables() {
  await database.query("delete from public.backup_settings");
  await database.query("delete from public.backup_runs");
  await database.query("delete from public.system_audit_events");
}

async function backupAuditEvents() {
  const result = await database.query<{
    event: string;
    metadata: Record<string, unknown>;
  }>(
    `select event, metadata from system_audit_events
     where event like 'backup_%' order by sequence`,
  );

  return result.rows;
}

before(async () => {
  database = await openTestDatabase();
});

beforeEach(clearTables);

after(async () => {
  await clearTables();
  await database.end();
});

test("a destination chosen in Settings is saved and audited, without the token", async () => {
  await saveBackupConfig(
    actor,
    {
      destination: { bucket: "acme-backups", kind: "gcs", prefix: "signudoc/" },
      enabled: true,
      keepDays: 45,
    },
    { database, env },
  );

  const saved = await readStoredBackupConfig(database);

  assert.equal(saved?.destination, "gcs");
  assert.equal(saved?.gcsBucket, "acme-backups");
  assert.equal(saved?.gcsPrefix, "signudoc/");
  assert.equal(saved?.keepDays, 45);

  await saveBackupConfig(
    actor,
    {
      destination: { kind: "blob", token: "vercel_blob_rw_Backup1_topsecret" },
      enabled: true,
      keepDays: 45,
    },
    { database, env },
  );

  const withToken = await readStoredBackupConfig(database);

  assert.equal(withToken?.destination, "blob");
  assert.equal(withToken?.gcsBucket, null);
  assert.ok(withToken?.blobTokenEncrypted);
  assert.doesNotMatch(withToken.blobTokenEncrypted, /topsecret/);

  // Saving again without a token keeps the saved one, and changes nothing.
  await saveBackupConfig(
    actor,
    { destination: { kind: "blob", token: null }, enabled: true, keepDays: 45 },
    { database, env },
  );

  assert.equal(
    (await readStoredBackupConfig(database))?.blobTokenEncrypted,
    withToken.blobTokenEncrypted,
  );

  const events = await backupAuditEvents();

  assert.equal(events.length, 2);
  assert.deepEqual(events[0]?.metadata.changes, [
    "destination",
    "bucket",
    "keep_days",
  ]);
  assert.deepEqual(events[1]?.metadata.changes, [
    "destination",
    "bucket",
    "blob_token",
  ]);
  assert.doesNotMatch(JSON.stringify(events), /topsecret/);
});

test("the app's own bucket cannot be saved as the backup bucket", async () => {
  await assert.rejects(
    saveBackupConfig(
      actor,
      {
        destination: { bucket: "docs", kind: "gcs", prefix: "" },
        enabled: true,
        keepDays: 30,
      },
      { database, env: { ...env, GCS_BUCKET: "docs" } },
    ),
    /own files/,
  );
  assert.equal(await readStoredBackupConfig(database), null);
});

test("what the deployment sets is not changed from Settings", async () => {
  const lockedEnv = {
    ...env,
    BACKUP_GCS_BUCKET: "from-env",
    BACKUP_KEEP_DAYS: "60",
  };

  await saveBackupConfig(
    actor,
    {
      destination: { bucket: "elsewhere", kind: "gcs", prefix: "" },
      enabled: true,
      keepDays: 7,
    },
    { database, env: lockedEnv },
  );

  const saved = await readStoredBackupConfig(database);

  assert.equal(saved?.destination, "none");
  assert.equal(saved?.gcsBucket, null);
  assert.equal(saved?.keepDays, 7);
});

test("a run is recorded, and its outcome is the setup status", async () => {
  assert.equal(
    (await getBackupSetupStatus(database, env)).state,
    "not_configured",
  );
  assert.deepEqual(
    await runConfiguredBackup({
      database,
      deadline: Date.now() + 60_000,
      env,
      trigger: "schedule",
    }),
    { status: "not_configured" },
  );

  await saveBackupConfig(
    actor,
    {
      destination: { bucket: "acme-backups", kind: "gcs", prefix: "" },
      enabled: true,
      keepDays: 30,
    },
    { database, env },
  );

  const source = memoryStore();
  const target = memoryStore();

  source.objects.set("users/u1/a.pdf", Buffer.from("%PDF-1.7"));

  const outcome = await runConfiguredBackup({
    createSource: () => source,
    createTarget: (destination) => {
      assert.deepEqual(destination, {
        bucket: "acme-backups",
        kind: "gcs",
        prefix: "",
      });
      return target;
    },
    database,
    deadline: Date.now() + 60_000,
    env,
    trigger: "manual",
  });

  assert.equal(outcome.status, "finished");
  assert.ok(target.objects.has("files/users/u1/a.pdf"));

  const [first] = await listBackupRuns(10, database);

  assert.equal(first?.status, "succeeded");
  assert.equal(first?.trigger, "manual");
  assert.equal(first?.destination, "gs://acme-backups/");
  assert.equal(first?.summary?.filesCopied, 1);
  assert.equal((await getBackupSetupStatus(database, env)).state, "done");

  // A target that refuses: the run fails, and says why in plain words.
  const failed = await runConfiguredBackup({
    createSource: () => source,
    createTarget: () => memoryStore(new GcsRequestError("upload", 403)),
    database,
    deadline: Date.now() + 60_000,
    env,
    trigger: "schedule",
  });

  assert.equal(failed.status, "failed");

  const [latest] = await listBackupRuns(10, database);

  assert.equal(latest?.status, "failed");
  assert.match(latest?.error ?? "", /refused access \(403\)/);
  assert.equal((await getBackupSetupStatus(database, env)).state, "failing");
});

test("a second run waits for the first, and a turned-off schedule skips", async () => {
  await saveBackupConfig(
    actor,
    {
      destination: { bucket: "acme-backups", kind: "gcs", prefix: "" },
      enabled: false,
      keepDays: 30,
    },
    { database, env },
  );

  assert.deepEqual(
    await runConfiguredBackup({
      database,
      deadline: Date.now() + 60_000,
      env,
      trigger: "schedule",
    }),
    { status: "disabled" },
  );

  await database.query(
    `insert into backup_runs (id, started_at, status, trigger, destination)
     values ('busy', $1, 'running', 'schedule', 'gs://acme-backups/')`,
    [Math.floor(Date.now() / 1000)],
  );

  assert.deepEqual(
    await runConfiguredBackup({
      createSource: () => memoryStore(),
      createTarget: () => memoryStore(),
      database,
      deadline: Date.now() + 60_000,
      env,
      trigger: "manual",
    }),
    { status: "busy" },
  );

  // One left running long ago was stopped part way, and no longer blocks.
  await database.query(
    `update backup_runs set started_at = started_at - 3600 where id = 'busy'`,
  );

  const outcome = await runConfiguredBackup({
    createSource: () => memoryStore(),
    createTarget: () => memoryStore(),
    database,
    deadline: Date.now() + 60_000,
    env,
    trigger: "manual",
  });

  assert.equal(outcome.status, "finished");

  const runs = await listBackupRuns(10, database);

  assert.equal(runs.find((run) => run.id === "busy")?.status, "failed");
});

test("the run slot is claimed only when a run is about to start", async () => {
  let claims = 0;
  const claimSlot = async () => {
    claims += 1;

    return false;
  };
  const run = () =>
    runConfiguredBackup({
      claimSlot,
      createSource: () => memoryStore(),
      createTarget: () => memoryStore(),
      database,
      deadline: Date.now() + 60_000,
      env,
      trigger: "schedule",
    });

  // Nothing chosen yet: not configured, and the slot is not spent.
  assert.deepEqual(await run(), { status: "not_configured" });
  assert.equal(claims, 0);

  // Chosen but switched off: disabled, and the slot is not spent.
  await saveBackupConfig(
    actor,
    {
      destination: { bucket: "acme-backups", kind: "gcs", prefix: "" },
      enabled: false,
      keepDays: 30,
    },
    { database, env },
  );
  assert.deepEqual(await run(), { status: "disabled" });
  assert.equal(claims, 0);

  // Ready to run: the slot is claimed once, and a refusal starts no run.
  await saveBackupConfig(
    actor,
    {
      destination: { bucket: "acme-backups", kind: "gcs", prefix: "" },
      enabled: true,
      keepDays: 30,
    },
    { database, env },
  );
  assert.deepEqual(await run(), { status: "busy" });
  assert.equal(claims, 1);
  assert.equal((await listBackupRuns(10, database)).length, 0);
});
