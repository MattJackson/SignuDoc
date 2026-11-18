// Restores a SignuDoc install from the daily backup (src/lib/backup.ts) into
// a new, empty database and file store. See docs/backup-and-restore.md.
//
//   DATABASE_URL=postgres://...            the new, empty database
//     (or sqlite:/path/file.db for the SQLite backend)
//
//   Where the backup is, one of:
//   BACKUP_GCS_BUCKET=...                  a Cloud Storage bucket
//     (BACKUP_GCS_PREFIX=...                 and the folder in it, if any)
//   BACKUP_BLOB_READ_WRITE_TOKEN=...       a Vercel Blob store
//
//   Where the files go, one of:
//   BLOB_READ_WRITE_TOKEN=vercel_blob_rw_  the new install's Blob store
//   STORAGE_DRIVER=gcs GCS_BUCKET=...      the new install's bucket
//     (GCS_PREFIX=...                        and its folder, if any)
//   STORAGE_DRIVER=local                   this machine's disk
//
//   Google credentials, for a bucket: GOOGLE_ACCESS_TOKEN (for example
//   from `gcloud auth print-access-token`), GOOGLE_SERVICE_ACCOUNT_KEY, or
//   the metadata server when run on Google Cloud (a Cloud Run job).
//
//   npm run restore-backup -- --list            list the database backups
//   npm run restore-backup                      restore the newest one, and the files
//   npm run restore-backup -- --backup <path>   restore that one
//   npm run restore-backup -- --skip-files      the database only
//   npm run restore-backup -- --files-only      the files only, for example to
//                                               finish a copy that stopped
//
// It applies the migrations first, then loads the backup in one transaction,
// so a restore that fails leaves the database as it was.

import pg from "pg";

import {
  createVercelBlobStore,
  DATABASE_PREFIX,
  findLatestDatabaseBackup,
  readBackupTargetFromEnv,
  restoreDatabase,
  restoreFiles,
} from "../src/lib/backup.ts";
import {
  createAppFilesStore,
  createBackupTargetStore,
} from "../src/lib/backup-stores.ts";
import { getGoogleCredentials } from "../src/lib/integrations/google/credentials.ts";
import { type GcsTokenSource } from "../src/lib/services/storage/gcs.ts";
import { runMigrations } from "../db/migrate.mjs";
import { isSqliteUrl, SqlitePool } from "../src/lib/db/sqlite/pool.ts";

// A token from gcloud, so a restore from a laptop needs no service account
// key. It lasts an hour, which is enough for most restores; for a larger
// one, run this as a Cloud Run job or use a key.
function resolveGoogleCredentials(): GcsTokenSource | null {
  const token = process.env.GOOGLE_ACCESS_TOKEN?.trim();

  if (token) {
    return { getAccessToken: async () => token };
  }

  return getGoogleCredentials();
}

function readArgument(name: string): string | null {
  const index = process.argv.indexOf(name);

  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function requireVariable(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    console.error(`Set ${name} first. See docs/backup-and-restore.md.`);
    process.exit(1);
  }

  return value;
}

async function main() {
  const backupTarget = readBackupTargetFromEnv(process.env);

  if (!backupTarget) {
    console.error(
      "Set BACKUP_GCS_BUCKET or BACKUP_BLOB_READ_WRITE_TOKEN first. See docs/backup-and-restore.md.",
    );
    process.exit(1);
  }

  const credentials = resolveGoogleCredentials();
  const backupStore = createBackupTargetStore(backupTarget, credentials);

  if (process.argv.includes("--list")) {
    let cursor: string | undefined;

    do {
      const page = await backupStore.list({ cursor, prefix: DATABASE_PREFIX });

      for (const blob of page.blobs) {
        console.log(
          `${blob.pathname}  ${String(Math.round(blob.size / 1024))} KB`,
        );
      }

      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);

    return;
  }

  const filesOnly = process.argv.includes("--files-only");
  const skipFiles = process.argv.includes("--skip-files");

  if (filesOnly && skipFiles) {
    console.error("Choose --files-only or --skip-files, not both.");
    process.exit(1);
  }

  // Without STORAGE_DRIVER the files go to a Blob store, as they always did.
  const appStore = skipFiles
    ? null
    : process.env.STORAGE_DRIVER?.trim()
      ? createAppFilesStore({ credentials, env: process.env })
      : createVercelBlobStore(requireVariable("BLOB_READ_WRITE_TOKEN"));

  if (!filesOnly) {
    const connectionString = requireVariable("DATABASE_URL");
    const backupPath =
      readArgument("--backup") ?? (await findLatestDatabaseBackup(backupStore));

    if (!backupPath) {
      console.error("The backup store has no database backups yet.");
      process.exit(1);
    }

    console.log("Applying migrations…");
    await runMigrations({ connectionString });

    // A sqlite: URL restores into a SQLite file (docs/design/database-backends.md).
    const database = isSqliteUrl(connectionString)
      ? (new SqlitePool(connectionString) as unknown as pg.Pool)
      : new pg.Pool({ connectionString, max: 2 });

    try {
      console.log(`Restoring ${backupPath}…`);

      const { rows } = await restoreDatabase({
        backupPath,
        database,
        store: backupStore,
      });

      for (const [table, count] of Object.entries(rows)) {
        console.log(`  ${table}: ${String(count)} rows`);
      }
    } finally {
      await database.end();
    }
  }

  if (appStore) {
    console.log("Copying files…");

    const { copied, failures, skipped } = await restoreFiles({
      source: backupStore,
      target: appStore,
    });

    console.log(
      `  ${String(copied)} files copied, ${String(skipped)} already there.`,
    );

    if (failures.length > 0) {
      console.error(`  ${String(failures.length)} could not be copied:`);

      for (const pathname of failures) {
        console.error(`    ${pathname}`);
      }

      console.error(
        "  Run it again with --files-only to retry them; files already copied are skipped.",
      );
      process.exitCode = 1;
    }
  }

  if (process.exitCode) {
    console.error(
      "Not done: some files could not be copied; run again with --files-only before deploying.",
    );
    return;
  }

  console.log("Done. Deploy the new install and sign in to check it.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
