import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { DatabaseSync } from "node:sqlite";

import { listMigrationFiles } from "../migrate.mjs";
import {
  BASELINE_FILE,
  listSqliteMigrationFiles,
  readBaselineVersions,
  runSqliteMigrations,
} from "./migrate.mjs";
import { isSqliteUrl, openSqliteDatabase, sqliteFilePath } from "./open.mjs";

// Every schema change needs a Postgres migration (db/migrations) and a
// SQLite one with the same name (db/sqlite/migrations), unless the SQLite
// baseline already stands for it. See docs/design/database-backends.md.

test("every Postgres migration has a SQLite counterpart", async () => {
  const postgres = (await listMigrationFiles()).map((file) =>
    file.replace(/\.sql$/, ""),
  );
  const baseline = new Set(await readBaselineVersions());
  const sqlite = new Set(
    (await listSqliteMigrationFiles()).map((file) =>
      file.replace(/\.sql$/, ""),
    ),
  );
  const missing = postgres.filter(
    (version) => !baseline.has(version) && !sqlite.has(version),
  );

  assert.deepEqual(
    missing,
    [],
    "Add the SQLite version of each to db/sqlite/migrations, with the same file name.",
  );
});

test("the SQLite side names no migration Postgres does not have", async () => {
  const postgres = new Set(
    (await listMigrationFiles()).map((file) => file.replace(/\.sql$/, "")),
  );
  const strays = [
    ...(await readBaselineVersions()),
    ...(await listSqliteMigrationFiles()).map((file) =>
      file.replace(/\.sql$/, ""),
    ),
  ].filter((version) => !postgres.has(version));

  assert.deepEqual(strays, []);
});

test("a baseline version has no SQLite migration as well", async () => {
  const baseline = new Set(await readBaselineVersions());
  const both = (await listSqliteMigrationFiles())
    .map((file) => file.replace(/\.sql$/, ""))
    .filter((version) => baseline.has(version));

  assert.deepEqual(both, []);
});

test("migrating applies everything once, and records the Postgres names", async () => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "signudoc-sqlite-migrate-"),
  );
  const connectionString = `sqlite:${path.join(directory, "m.db")}`;

  try {
    const first = await runSqliteMigrations({
      connectionString,
      log: () => {},
    });
    const second = await runSqliteMigrations({
      connectionString,
      log: () => {},
    });

    assert.ok(first.applied.length > 0);
    assert.deepEqual(second.applied, []);

    const database = openSqliteDatabase(connectionString);

    try {
      const recorded = database
        .prepare("select version from signudoc_migrations order by version")
        .all()
        .map((row) => row.version);
      const expected = [
        ...(await readBaselineVersions()),
        ...(await listSqliteMigrationFiles()).map((file) =>
          file.replace(/\.sql$/, ""),
        ),
      ].sort();

      assert.deepEqual(recorded, expected);
      assert.equal(
        database.prepare("pragma journal_mode").get().journal_mode,
        "wal",
      );
      assert.equal(
        database.prepare("pragma foreign_keys").get().foreign_keys,
        1,
      );
    } finally {
      database.close();
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("sqlite: connection strings name a file", () => {
  assert.equal(isSqliteUrl("sqlite:/data/x.db"), true);
  assert.equal(isSqliteUrl("postgres://a@b/c"), false);
  assert.equal(sqliteFilePath("sqlite:/data/x.db"), "/data/x.db");
  assert.equal(sqliteFilePath("sqlite:///data/x.db"), "/data/x.db");
  assert.equal(sqliteFilePath("sqlite:rel/x.db"), path.resolve("rel/x.db"));
});

test("the app's copy of open.mjs reads sqlite: URLs the same way", async () => {
  const copy = await import("../../src/lib/db/sqlite/open.ts");

  for (const url of [
    "sqlite:/data/x.db",
    "sqlite:///data/x.db",
    "sqlite:rel/x.db",
    "SQLITE:/data/a%20b.db?mode=rw",
    "postgres://a@b/c",
  ]) {
    assert.equal(copy.isSqliteUrl(url), isSqliteUrl(url), url);

    if (isSqliteUrl(url)) {
      assert.equal(copy.sqliteFilePath(url), sqliteFilePath(url), url);
    }
  }
});

test("moving to Unicode lower() renames names that now collide and removes no row", async () => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "signudoc-sqlite-unicode-"),
  );
  const connectionString = `sqlite:${path.join(directory, "u.db")}`;

  try {
    // A database as an older version left it: the baseline, indexes built
    // with SQLite's own lower(), which folds ASCII only.
    const old = new DatabaseSync(path.join(directory, "u.db"));

    old.exec(readFileSync(BASELINE_FILE, "utf8"));
    old.exec(
      "create table signudoc_migrations (version text not null primary key, applied_at timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))",
    );

    for (const version of await readBaselineVersions()) {
      old
        .prepare("insert into signudoc_migrations (version) values (?)")
        .run(version);
    }

    const team = old.prepare(
      "insert into teams (id, name, google_group_email, created_at, updated_at) values (?, ?, ?, 1, 1)",
    );

    team.run("t1", "Équipe", "Ü@x.test");
    team.run("t2", "équipe", "ü@x.test");
    team.run("t3", "Plain", null);
    old
      .prepare(
        `insert into "user" (id, name, email, "emailVerified", role) values ('u1', 'U', 'u@x.test', 1, 'user')`,
      )
      .run();
    old
      .prepare(
        "insert into envelopes (id, user_id, title, source_pdf_key, source_pdf_filename, source_pdf_size_bytes, page_count, source_pdf_hash) values ('e1', 'u1', 'T', 'k', 'f.pdf', 1, 1, ?)",
      )
      .run("a".repeat(64));

    const signer = old.prepare(
      "insert into signers (id, envelope_id, name, email, sign_order) values (?, 'e1', 'S', ?, ?)",
    );

    signer.run("s1", "É@x.test", 1);
    signer.run("s2", "é@x.test", 2);
    old.close();

    await runSqliteMigrations({ connectionString, log: () => {} });

    const database = openSqliteDatabase(connectionString);

    try {
      const teams = database
        .prepare(
          "select id, name, google_group_email as email from teams order by id",
        )
        .all();

      assert.equal(teams.length, 3);
      assert.deepEqual(
        teams.map((row) => [row.id, row.name]),
        [
          ["t1", "Équipe"],
          ["t2", "équipe (2)"],
          ["t3", "Plain"],
        ],
      );
      assert.equal(teams[0].email, "Ü@x.test");
      assert.equal(teams[1].email, "ü@x.test");

      const signers = database
        .prepare("select id, email from signers order by id")
        .all();

      assert.equal(signers.length, 2);
      assert.equal(signers[0].email, "É@x.test");
      assert.equal(signers[1].email, "é@x.test");

      // The indexes are rebuilt, so a new collision is refused.
      assert.throws(
        () =>
          database
            .prepare(
              "insert into teams (id, name, created_at, updated_at) values ('t9', 'ÉQUIPE', 1, 1)",
            )
            .run(),
        /UNIQUE/,
      );
    } finally {
      database.close();
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
