// The app's copy of db/sqlite/open.mjs: the same rules for a sqlite: URL and
// the same connection settings. The two are kept apart because the
// end-to-end tests load this module through Playwright, which cannot load
// .mjs files, while db/migrate.mjs and the container's start script run as
// plain JavaScript before anything is compiled. db/sqlite/migrations.test.mjs
// checks that the two agree.
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

/** How long a connection waits for another process's lock on the file. */
export const SQLITE_BUSY_TIMEOUT_MS = 5_000;

export function isSqliteUrl(
  connectionString: string | undefined | null,
): boolean {
  return (
    typeof connectionString === "string" &&
    connectionString.trim().toLowerCase().startsWith("sqlite:")
  );
}

/** The file a sqlite: connection string names, as an absolute path. */
export function sqliteFilePath(connectionString: string): string {
  if (!isSqliteUrl(connectionString)) {
    throw new Error("Not a sqlite: connection string.");
  }

  let rest = connectionString.trim().slice("sqlite:".length);

  if (rest.startsWith("//")) {
    rest = rest.slice(2);
  }

  rest = decodeURIComponent(rest.split("?")[0] ?? "");

  if (!rest) {
    throw new Error("The sqlite: connection string names no file.");
  }

  return path.resolve(rest);
}

/**
 * Opens the file with the settings every connection uses: WAL, so the
 * read-only connection and Litestream read while the app writes;
 * synchronous=FULL, so a commit is on disk before it returns; foreign keys.
 */
export function openSqliteDatabase(
  connectionString: string,
  { readOnly = false }: { readOnly?: boolean } = {},
): DatabaseSync {
  const file = sqliteFilePath(connectionString);
  // Loaded only when SQLite is used, so a Postgres install never loads it.
  const { DatabaseSync: Database } = process.getBuiltinModule(
    "node:sqlite",
  ) as { DatabaseSync: typeof DatabaseSync };

  if (!readOnly) {
    mkdirSync(path.dirname(file), { recursive: true });
  }

  const database = new Database(file, {
    enableForeignKeyConstraints: true,
    readOnly,
    timeout: SQLITE_BUSY_TIMEOUT_MS,
  });

  try {
    if (!readOnly) {
      database.exec("PRAGMA journal_mode = WAL");
    }

    database.exec("PRAGMA synchronous = FULL");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(`PRAGMA busy_timeout = ${String(SQLITE_BUSY_TIMEOUT_MS)}`);
  } catch (error) {
    database.close();
    throw error;
  }

  return database;
}
