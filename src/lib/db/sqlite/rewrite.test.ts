import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { CATALOG_VIEWS_SQL, registerFunctions } from "./functions.ts";
import { rewriteSql, UnsupportedSqlError } from "./rewrite.ts";
import { readSchemaInfo } from "./schema.ts";
import { collectSqlCorpus } from "./sql-corpus.ts";
import { POSTGRES_ONLY, STAND_INS } from "./sql-corpus-exceptions.ts";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

/** A database with the SQLite schema (the baseline and the migrations after it), as the app opens one. */
function baselineDatabase() {
  const database = new DatabaseSync(":memory:");

  registerFunctions(database, {
    lockWaiters: () => 0,
    now: () => new Date().toISOString(),
  });
  database.exec(
    readFileSync(path.join(root, "db/sqlite/baseline.sql"), "utf8"),
  );

  const migrations = path.join(root, "db/sqlite/migrations");

  for (const file of readdirSync(migrations)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    database.exec(readFileSync(path.join(migrations, file), "utf8"));
  }

  database.exec(
    "create table signudoc_migrations (version text primary key, applied_at timestamptz not null)",
  );
  database.exec(CATALOG_VIEWS_SQL);

  return database;
}

const database = baselineDatabase();
const schema = readSchemaInfo(database);

function sqlite(sql: string) {
  return rewriteSql(sql, schema).sql;
}

test("every SQL statement in the app runs on SQLite", () => {
  const corpus = collectSqlCorpus(root);
  const failures: string[] = [];
  const usedStandIns = new Set<string>();
  const usedExceptions = new Set<string>();

  // Not a vacuous pass: the app sends hundreds of statements.
  assert.ok(
    corpus.length > 300,
    `only ${String(corpus.length)} statements found`,
  );

  for (const entry of corpus) {
    const where = `${entry.file}:${String(entry.line)}`;

    entry.standIns.forEach((standIn) => usedStandIns.add(standIn));

    const exception = POSTGRES_ONLY.find(
      (candidate) =>
        candidate.file === entry.file && entry.sql.includes(candidate.contains),
    );

    if (exception) {
      usedExceptions.add(`${exception.file}|${exception.contains}`);
      continue;
    }

    if (entry.unresolved.length > 0) {
      failures.push(
        `${where}: cannot work out ${entry.unresolved.map((text) => `\${${text}}`).join(", ")}. Add a stand-in to src/lib/db/sqlite/sql-corpus-exceptions.ts.`,
      );
      continue;
    }

    try {
      const rewritten = rewriteSql(entry.sql, schema);

      if (
        rewritten.kind === "begin" ||
        rewritten.kind === "commit" ||
        rewritten.kind === "rollback"
      ) {
        continue;
      }

      // Preparing checks the syntax, every table, column and function, and
      // that each ON CONFLICT target is a unique index.
      for (const step of rewritten.preSteps ?? []) {
        database.prepare(step.sql);
      }

      database.prepare(rewritten.sql);
    } catch (error) {
      failures.push(
        `${where}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  for (const key of Object.keys(STAND_INS)) {
    if (!usedStandIns.has(key)) {
      failures.push(
        `The stand-in for \${${key}} is used by no statement any more. Remove it.`,
      );
    }
  }

  for (const exception of POSTGRES_ONLY) {
    if (!usedExceptions.has(`${exception.file}|${exception.contains}`)) {
      failures.push(
        `The Postgres-only entry for ${exception.file} (${exception.contains}) matches nothing any more. Remove it.`,
      );
    }
  }

  assert.deepEqual(failures, []);
});

test("parameters are numbered, so one used twice binds once", () => {
  assert.equal(sqlite("SELECT $1, $2, $1"), "SELECT ?1, ?2, ?1");
});

test("public. is dropped from table names, nowhere else", () => {
  assert.equal(
    sqlite(`SELECT 'public.x' FROM public."user" u WHERE u.id = $1`),
    `SELECT 'public.x' FROM "user" u WHERE u.id = ?1`,
  );
});

test("to_regclass tells whether a table exists", () => {
  const exists = (name: string) =>
    database
      .prepare(sqlite(`SELECT to_regclass('${name}') IS NOT NULL AS present`))
      .get() as { present: number };

  assert.equal(exists("envelopes").present, 1);
  assert.equal(exists("public.envelopes").present, 1);
  assert.equal(exists("no_such_table").present, 0);
});

test("casts keep their Postgres meaning", () => {
  assert.equal(
    sqlite("SELECT count(*)::int AS n FROM envelopes"),
    "SELECT pg_int(count(*)) AS n FROM envelopes",
  );
  assert.equal(
    sqlite("SELECT $1::bigint + $2::bigint"),
    "SELECT pg_int(?1) + pg_int(?2)",
  );
  assert.equal(
    sqlite("SELECT id::text FROM envelopes"),
    `SELECT CAST(id AS TEXT) AS "id" FROM envelopes`,
  );
  assert.equal(sqlite("SELECT '{}'::jsonb, $1::text[]"), "SELECT '{}', ?1");
  assert.equal(
    sqlite(
      "SELECT count(*) FILTER (WHERE status = 'sent')::int AS n FROM envelopes",
    ),
    "SELECT pg_int(count(*) FILTER(WHERE status = 'sent')) AS n FROM envelopes",
  );
  assert.equal(
    sqlite("SELECT x::text::int FROM t"),
    `SELECT pg_int(CAST(x AS TEXT)) AS "x" FROM t`,
  );
  assert.equal(sqlite("SELECT 'a::b'"), "SELECT 'a::b'");
  assert.throws(() => sqlite("SELECT 'x'::regclass"), UnsupportedSqlError);
});

test("row locks are removed, every form of them", () => {
  for (const clause of [
    "FOR UPDATE",
    "FOR UPDATE OF e",
    "FOR UPDATE OF e, s SKIP LOCKED",
    "FOR NO KEY UPDATE",
    "FOR SHARE OF u",
    "FOR KEY SHARE NOWAIT",
  ]) {
    assert.equal(
      sqlite(`SELECT id FROM envelopes e WHERE id = $1 ${clause}`),
      "SELECT id FROM envelopes e WHERE id = ?1",
    );
  }
});

test("= ANY and <> ALL read a JSON array", () => {
  assert.equal(
    sqlite("SELECT id FROM signers WHERE id = ANY($1::text[])"),
    "SELECT id FROM signers WHERE id IN(SELECT value FROM json_each(?1))",
  );
  assert.equal(
    sqlite("SELECT id FROM signers WHERE id <> ALL($1)"),
    "SELECT id FROM signers WHERE id NOT IN(SELECT value FROM json_each(?1))",
  );
  assert.equal(
    sqlite("SELECT 1 WHERE 'a' = ANY(SELECT id FROM signers)"),
    "SELECT 1 WHERE 'a' IN(SELECT id FROM signers)",
  );
});

test("dates: EXTRACT, intervals, now()", () => {
  assert.equal(
    sqlite("SELECT extract(epoch from now())::int - 3600"),
    "SELECT pg_int(pg_epoch(now())) - 3600",
  );
  assert.equal(
    sqlite(`UPDATE session SET "expiresAt" = now() - interval '1 minute'`),
    `UPDATE session SET "expiresAt" = pg_interval_add(now(), '1 minute', -1)`,
  );
  assert.equal(sqlite("SELECT CURRENT_TIMESTAMP"), "SELECT now()");
});

test("special forms: position, substring, unnest, generate_series, ARRAY", () => {
  assert.equal(
    sqlite("SELECT position($1 in lower(name)) FROM t"),
    "SELECT instr(lower(name), ?1) FROM t",
  );
  assert.equal(
    sqlite("SELECT substring(email from '@([^@]+)$') FROM t"),
    "SELECT pg_regexp_substring(email, '@([^@]+)$') FROM t",
  );
  assert.equal(
    sqlite("SELECT substring(x from 2 for 3) FROM t"),
    "SELECT substr(x, 2, 3) FROM t",
  );
  assert.equal(
    sqlite("SELECT key FROM unnest($1::text[]) AS key"),
    "SELECT key FROM(SELECT value AS key FROM json_each(?1)) AS key",
  );
  assert.match(
    sqlite("SELECT n FROM generate_series(1, $2::int) as n"),
    /WITH RECURSIVE _series/,
  );
  assert.equal(
    sqlite("SELECT ARRAY(SELECT id FROM signers ORDER BY id) AS ids"),
    "SELECT(SELECT json_group_array(id ORDER BY id) FROM signers) AS ids",
  );
  assert.equal(sqlite("SELECT ARRAY[$1, $2]"), "SELECT json_array(?1, ?2)");
});

test("UPDATE and DELETE aliases, and FROM tables in RETURNING", () => {
  assert.equal(
    sqlite("DELETE FROM notification_events e WHERE e.id = $1"),
    "DELETE FROM notification_events AS e WHERE e.id = ?1",
  );
  assert.equal(
    sqlite(
      "UPDATE drive_exports x SET attempts = 0 FROM envelopes e WHERE x.envelope_id = $1 AND e.id = x.envelope_id RETURNING e.title",
    ),
    `UPDATE drive_exports AS x SET attempts = 0 FROM envelopes e WHERE x.envelope_id = ?1 AND e.id = x.envelope_id RETURNING(SELECT e.title FROM envelopes e WHERE(e.id = drive_exports.envelope_id) LIMIT 1) AS "title"`,
  );
  assert.equal(
    sqlite(
      "UPDATE notification_deliveries d SET attempts = 1 WHERE d.id = $1 RETURNING d.id",
    ),
    "UPDATE notification_deliveries AS d SET attempts = 1 WHERE d.id = ?1 RETURNING notification_deliveries.id",
  );
});

test("ON CONFLICT ON CONSTRAINT names the constraint's columns", () => {
  assert.match(
    sqlite(
      "INSERT INTO notification_deliveries (id) VALUES ($1) ON CONFLICT ON CONSTRAINT notification_deliveries_once DO NOTHING",
    ),
    /ON CONFLICT\("event_id", "channel", "target_kind", "target"\) DO NOTHING/,
  );
});

test("INSERT … SELECT … ON CONFLICT gets the WHERE SQLite's grammar needs", () => {
  assert.equal(
    sqlite(
      "INSERT INTO rate_limits (key, count, expires_at) SELECT key, 1, 2 FROM t ON CONFLICT (key) DO NOTHING",
    ),
    "INSERT INTO rate_limits(key, count, expires_at) SELECT key, 1, 2 FROM t WHERE true ON CONFLICT(key) DO NOTHING",
  );
});

test("TRUNCATE is a DELETE", () => {
  assert.equal(sqlite(`truncate public."user" cascade`), `DELETE FROM "user"`);
});

test("a data-modifying WITH runs as two statements", () => {
  const rewritten = rewriteSql(
    `WITH removed AS (DELETE FROM team_members WHERE team_id = $1 AND user_id = $2 RETURNING user_id) SELECT u.name FROM removed JOIN "user" u ON u.id = removed.user_id`,
    schema,
  );

  assert.deepEqual(rewritten.preSteps, [
    {
      parameterCount: 2,
      rowsParameter: 3,
      sql: "DELETE FROM team_members WHERE team_id = ?1 AND user_id = ?2 RETURNING user_id",
    },
  ]);
  assert.match(
    rewritten.sql,
    /WITH removed\("user_id"\) AS\(SELECT json_extract\(value, '\$\[0\]'\) FROM json_each\(\?3\)\)/,
  );
});

test("a WITH that modifies data in several parts runs as a statement per part", () => {
  const rewritten = rewriteSql(
    `WITH due AS (
       SELECT d.id FROM webhook_deliveries d WHERE d.status = 'pending'
       ORDER BY d.id LIMIT $2 FOR UPDATE OF d SKIP LOCKED
     ),
     claimed AS (
       UPDATE webhook_deliveries d SET attempts = d.attempts + 1, updated_at = $1
       FROM due WHERE d.id = due.id
       RETURNING d.*
     ),
     noted AS (
       UPDATE webhook_endpoints SET updated_at = $1
       WHERE id IN (SELECT endpoint_id FROM claimed)
     )
     SELECT c.id, c.payload FROM claimed c ORDER BY c.id`,
    schema,
  );
  const [claim, note] = rewritten.preSteps ?? [];

  assert.equal(rewritten.preSteps?.length, 2);
  assert.match(
    claim!.sql,
    /^WITH due AS\(SELECT d\.id FROM webhook_deliveries d/,
  );
  assert.doesNotMatch(claim!.sql, /FOR UPDATE|SKIP LOCKED/);
  assert.match(
    claim!.sql,
    /UPDATE webhook_deliveries AS d SET .* RETURNING webhook_deliveries\."id", webhook_deliveries\."endpoint_id"/,
  );
  assert.equal(claim!.parameterCount, 2);
  assert.equal(claim!.rowsParameter, 3);
  // The next part reads the rows of the one before it.
  assert.match(note!.sql, /claimed\("id", "endpoint_id".*json_each\(\?3\)/);
  assert.equal(note!.rowsParameter, null);
  assert.equal(note!.parameterCount, 3);
  assert.match(rewritten.sql, /json_each\(\?3\)\) SELECT c\.id, c\.payload/);
  assert.equal(rewritten.parameterCount, 3);

  for (const step of rewritten.preSteps ?? []) {
    database.prepare(step.sql);
  }

  database.prepare(rewritten.sql);
});

test("an upsert after a data-modifying WITH gets the WHERE SQLite's grammar needs", () => {
  const rewritten = rewriteSql(
    `WITH claim AS (UPDATE teams SET updated_at = 1 WHERE id = $1 RETURNING id)
     INSERT INTO team_members (team_id, user_id, added_at)
     SELECT claim.id, $2, 1 FROM claim
     ON CONFLICT (team_id, user_id) DO UPDATE SET added_at = EXCLUDED.added_at`,
    schema,
  );

  assert.match(
    rewritten.sql,
    /SELECT claim\.id, \?2, 1 FROM claim WHERE true ON CONFLICT\(team_id, user_id\) DO UPDATE SET added_at = EXCLUDED\.added_at$/,
  );
  database.prepare(rewritten.sql);
});

test("RETURNING * names the target's columns", () => {
  assert.match(
    sqlite("DELETE FROM team_members WHERE team_id = $1 RETURNING *"),
    /RETURNING "team_id", "user_id", "added_at"$/,
  );
});

test("unnest(…) AS t(column) names its one column", () => {
  assert.equal(
    sqlite(
      "SELECT s.n FROM teams CROSS JOIN unnest($1::int[]) AS s(n) WHERE true",
    ),
    "SELECT s.n FROM teams CROSS JOIN(SELECT value AS n FROM json_each(?1)) AS s WHERE true",
  );
});

test("a parenthesized part of a UNION keeps its ORDER BY and LIMIT", () => {
  const rewritten = sqlite(
    `WITH listed AS (
       SELECT id, 0 AS g FROM api_keys WHERE revoked_at IS NULL
       UNION ALL
       (SELECT id, 1 AS g FROM api_keys WHERE revoked_at IS NOT NULL ORDER BY revoked_at DESC LIMIT $1)
     )
     SELECT id FROM listed ORDER BY g`,
  );

  assert.match(
    rewritten,
    /UNION ALL SELECT \* FROM\(SELECT id, 1 AS g FROM api_keys WHERE revoked_at IS NOT NULL ORDER BY revoked_at DESC LIMIT \?1\)/,
  );
  database.prepare(rewritten);
});

test("LOCK TABLE takes the write lock, as any write does", () => {
  const rewritten = rewriteSql(
    "LOCK TABLE webhook_endpoints IN SHARE ROW EXCLUSIVE MODE",
  );

  assert.equal(rewritten.kind, "write");
  database.prepare(rewritten.sql);
});

test("a cast column keeps the name Postgres gives it", () => {
  assert.equal(
    sqlite("SELECT last_used_at::text, count(*)::int FROM api_keys"),
    `SELECT CAST(last_used_at AS TEXT) AS "last_used_at", pg_int(count(*)) AS "count" FROM api_keys`,
  );
  assert.equal(
    sqlite("SELECT last_used_at::text AS t FROM api_keys"),
    "SELECT CAST(last_used_at AS TEXT) AS t FROM api_keys",
  );
});

test("IS NOT DISTINCT FROM does not end the select list", () => {
  assert.deepEqual(
    Object.fromEntries(
      rewriteSql(
        `SELECT CASE WHEN u.a IS NOT DISTINCT FROM u.b THEN 1 END AS x, EXISTS (SELECT 1) AS closing FROM "user" u`,
        schema,
      ).hints,
    ),
    { closing: "bool" },
  );
});

test("REPEATABLE READ asks for one snapshot", () => {
  assert.equal(
    rewriteSql("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY").snapshot,
    true,
  );
  assert.equal(rewriteSql("BEGIN").snapshot, undefined);
});

test("advisory locks are recognized, with their key expression", () => {
  const blocking = rewriteSql(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 7))",
  );
  const attempt = rewriteSql("select pg_try_advisory_xact_lock($1) as locked");

  assert.equal(blocking.kind, "advisory");
  assert.equal(blocking.sql, "SELECT hashtextextended(?1, 7)");
  assert.deepEqual(blocking.advisory, {
    column: "pg_advisory_xact_lock",
    isTry: false,
  });
  assert.deepEqual(attempt.advisory, { column: "locked", isTry: true });
});

test("statements are classified: reads go to the reader, the rest take the write lock", () => {
  assert.equal(rewriteSql("SELECT 1").kind, "read");
  assert.equal(rewriteSql("WITH x AS (SELECT 1) SELECT * FROM x").kind, "read");
  assert.equal(
    rewriteSql("WITH x AS (SELECT 1) UPDATE t SET a = 1").kind,
    "write",
  );
  assert.equal(rewriteSql("UPDATE t SET a = 1").kind, "write");
  assert.equal(
    rewriteSql("SELECT a FROM t WHERE id = $1 FOR UPDATE").kind,
    "locking-read",
  );
  assert.equal(
    rewriteSql("SELECT a / b FROM t").sql,
    "SELECT a / pg_nonzero(b) FROM t",
  );
  assert.equal(
    rewriteSql("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY").kind,
    "begin",
  );
  assert.equal(rewriteSql("commit").kind, "commit");
  assert.equal(rewriteSql("ROLLBACK").kind, "rollback");
});

test("computed columns are given the type Postgres would return", () => {
  const hints = (sql: string) =>
    Object.fromEntries(rewriteSql(sql, schema).hints);

  assert.deepEqual(
    hints(
      `SELECT EXISTS (SELECT 1 FROM signers) AS "hasSigners", count(*) AS n FROM envelopes`,
    ),
    {
      hasSigners: "bool",
    },
  );
  assert.deepEqual(
    hints("SELECT a = b AS same, x IS NULL AS missing, NOT y AS no FROM t"),
    {
      missing: "bool",
      no: "bool",
      same: "bool",
    },
  );
  assert.deepEqual(
    hints(
      `SELECT jsonb_build_object('a', 1) AS o, metadata -> 'x' AS j, ARRAY(SELECT 1 FROM t) AS a FROM t`,
    ),
    {
      a: "json",
      j: "json",
      o: "json",
    },
  );
  assert.deepEqual(
    hints(
      `SELECT max("createdAt") AS latest, coalesce(part11, false) AS p FROM t`,
    ),
    {
      latest: "date",
      p: "bool",
    },
  );
  assert.deepEqual(
    hints("SELECT CASE WHEN a = 1 THEN true ELSE false END AS flag FROM t"),
    { flag: "bool" },
  );
  assert.deepEqual(hints("UPDATE t SET a = 1 RETURNING (b > 1) AS big"), {
    big: "bool",
  });
  assert.deepEqual(
    hints("SELECT $1::text AS t, metadata->>'x' AS s FROM t"),
    {},
  );
});

test("Postgres SQL with no SQLite translation fails loudly", () => {
  for (const sql of [
    "SELECT DISTINCT ON (a) a FROM t",
    "SELECT * FROM t, LATERAL (SELECT 1) x",
    "SELECT * FROM t WHERE a ILIKE $1",
    "SELECT * FROM t WHERE a ~ $1",
    "DELETE FROM t USING u WHERE t.id = u.id",
    "SELECT 1; SELECT 2",
    "SELECT $$x$$",
  ]) {
    assert.throws(() => sqlite(sql), UnsupportedSqlError, sql);
  }
});
