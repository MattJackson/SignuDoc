// The end-to-end tests' own way into the test database, on either backend
// (docs/design/database-backends.md). With a sqlite: URL the file is the
// one the app under test has open too; SQLite's file locks keep the two
// processes apart.
import { rmSync } from "node:fs";

import pg from "pg";

import { isSqliteUrl, sqliteFilePath } from "../../db/sqlite/open.mjs";
import { SqlitePool } from "../../src/lib/db/sqlite/pool.ts";

/** Instead of `new pg.Pool({ connectionString })`. */
export function openE2ePool(connectionString: string): pg.Pool {
  return isSqliteUrl(connectionString)
    ? (new SqlitePool(connectionString) as unknown as pg.Pool)
    : new pg.Pool({ connectionString });
}

/** Instead of `new pg.Client({ connectionString })`: connect, query, end. */
export function openE2eClient(connectionString: string): pg.Client {
  if (!isSqliteUrl(connectionString)) {
    return new pg.Client({ connectionString });
  }

  const pool = new SqlitePool(connectionString);

  return {
    connect: async () => undefined,
    end: () => pool.end(),
    query: (text: string, values?: unknown[]) => pool.query(text, values),
  } as unknown as pg.Client;
}

/**
 * Empties a SQLite test database before the migrations run again: every
 * table, view and trigger is dropped, rather than the file deleted, in case
 * the app under test already has it open.
 */
export async function wipeSqliteDatabase(connectionString: string) {
  const { DatabaseSync } = await import("node:sqlite");
  const file = sqliteFilePath(connectionString);
  const database = new DatabaseSync(file);

  try {
    database.exec("PRAGMA foreign_keys = OFF");

    const objects = database
      .prepare(
        "SELECT type, name FROM sqlite_master WHERE type IN ('table', 'view', 'trigger') AND name NOT LIKE 'sqlite_%'",
      )
      .all() as { name: string; type: string }[];

    for (const { name, type } of objects.filter(
      (object) => object.type !== "table",
    )) {
      database.exec(
        `DROP ${type.toUpperCase()} IF EXISTS "${name.replace(/"/g, '""')}"`,
      );
    }

    for (const { name } of objects.filter(
      (object) => object.type === "table",
    )) {
      database.exec(`DROP TABLE IF EXISTS "${name.replace(/"/g, '""')}"`);
    }
  } finally {
    database.close();
  }

  // Left over from a run that ended mid-write, a journal would be replayed.
  rmSync(`${file}-journal`, { force: true });
}
