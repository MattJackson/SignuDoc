// Migrations for the SQLite backend, called by db/migrate.mjs for a sqlite:
// connection string. See docs/design/database-backends.md.
//
// - An empty database gets baseline.sql, the schema every Postgres migration
//   listed in baseline.versions produces, and those versions are recorded.
// - Then each file in db/sqlite/migrations not yet recorded is applied in
//   filename order, each in its own transaction. Each is the SQLite version
//   of the Postgres migration with the same name.
//
// The versions recorded in signudoc_migrations are the Postgres migration
// names on both backends, so a backup from one restores into the other.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openSqliteDatabase } from "./open.mjs";

const SQLITE_DIR = path.dirname(fileURLToPath(import.meta.url));

export const BASELINE_FILE = path.join(SQLITE_DIR, "baseline.sql");
export const BASELINE_VERSIONS_FILE = path.join(
  SQLITE_DIR,
  "baseline.versions",
);
export const SQLITE_MIGRATIONS_DIR = path.join(SQLITE_DIR, "migrations");

/** @returns {Promise<string[]>} */
export async function readBaselineVersions() {
  const text = await readFile(BASELINE_VERSIONS_FILE, "utf8");

  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/** @returns {Promise<string[]>} */
export async function listSqliteMigrationFiles(
  migrationsDir = SQLITE_MIGRATIONS_DIR,
) {
  const entries = await readdir(migrationsDir).catch(() => []);

  return entries.filter((entry) => entry.endsWith(".sql")).sort();
}

/**
 * @param {import("node:sqlite").DatabaseSync} database
 * @param {() => void} work
 */
function inTransaction(database, work) {
  database.exec("BEGIN IMMEDIATE");

  try {
    work();
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) {
      database.exec("ROLLBACK");
    }

    throw error;
  }
}

/**
 * @param {{ connectionString: string, log?: (line: string) => void }} options
 * @returns {Promise<{ applied: string[], total: number }>}
 */
export async function runSqliteMigrations({
  connectionString,
  log = console.log,
}) {
  const database = openSqliteDatabase(connectionString);

  try {
    database.exec(`
      create table if not exists signudoc_migrations (
        version text not null primary key,
        applied_at timestamptz not null
          default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )
    `);

    const baselineVersions = await readBaselineVersions();
    const files = await listSqliteMigrationFiles();
    const applied = [];
    const insertVersion = database.prepare(
      "insert into signudoc_migrations (version) values (?)",
    );
    const appliedVersions = () =>
      new Set(
        database
          .prepare("select version from signudoc_migrations")
          .all()
          .map((row) => String(row.version)),
      );

    if (appliedVersions().size === 0) {
      const baseline = await readFile(BASELINE_FILE, "utf8");

      inTransaction(database, () => {
        // Checked again inside the write lock: another process may have
        // migrated the file in the meantime.
        if (appliedVersions().size > 0) {
          return;
        }

        database.exec(baseline);

        for (const version of baselineVersions) {
          insertVersion.run(version);
        }

        applied.push(...baselineVersions);
      });

      if (applied.length > 0) {
        log(
          `[migrate] applied the SQLite baseline (${String(baselineVersions.length)} migrations)`,
        );
      }
    }

    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      const sql = await readFile(
        path.join(SQLITE_MIGRATIONS_DIR, file),
        "utf8",
      );
      let ran = false;

      try {
        inTransaction(database, () => {
          if (appliedVersions().has(version)) {
            return;
          }

          database.exec(sql);
          insertVersion.run(version);
          ran = true;
        });
      } catch (error) {
        throw new Error(
          `Migration ${file} failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }

      if (ran) {
        log(`[migrate] applied ${file}`);
        applied.push(version);
      }
    }

    return { applied, total: baselineVersions.length + files.length };
  } finally {
    database.close();
  }
}
