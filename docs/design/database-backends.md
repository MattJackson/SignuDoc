# Database backends: Postgres and SQLite

Status: accepted, implemented on branch `sqlite-backend`.

SignuDoc talks to Postgres through `pg`. This fork adds a second backend, a SQLite file, so that a rarely used install can run on one Cloud Run instance that scales to zero, with the file replicated continuously to Google Cloud Storage by [Litestream](https://litestream.io). Postgres stays the default and is unchanged: Vercel, upstream and every existing install keep working exactly as before.

The priorities, in order:

1. Correctness of the signing evidence, and durability of the data.
2. A simple data-access layer.
3. Minimal merge friction with upstream, which this fork merges weekly. Every line changed at a SQL call site is a future conflict.
4. $0 when idle.

## Contents

- [Choosing the backend](#choosing-the-backend)
- [The executor interface](#the-executor-interface)
- [How SQLite runs Postgres SQL](#how-sqlite-runs-postgres-sql)
- [Types](#types)
- [Transactions and concurrency](#transactions-and-concurrency)
- [Schema and migrations](#schema-and-migrations)
- [Better Auth](#better-auth)
- [Tests and CI](#tests-and-ci)
- [Durability on Cloud Run with Litestream](#durability-on-cloud-run-with-litestream)
- [Backups](#backups)
- [Switching backends later](#switching-backends-later)
- [Merge friction](#merge-friction)
- [Deviations from the brief](#deviations-from-the-brief)
- [Further simplification, not done](#further-simplification-not-done)

## Choosing the backend

The backend is chosen by the connection string, nothing else:

| `DATABASE_URL`                                 | Backend            |
| ---------------------------------------------- | ------------------ |
| `postgres://…`, `postgresql://…` (and Neon's…) | Postgres (default) |
| `sqlite:/absolute/path/file.db`                | SQLite             |
| `sqlite:relative/path/file.db`                 | SQLite, from cwd   |
| `sqlite:///absolute/path/file.db`              | SQLite             |

`db/sqlite/open.mjs` parses it and opens the file. It is plain JavaScript so that `db/migrate.mjs`, the container's start script and the app share it, as they already share `db/database-url.mjs`.

SQLite is Node 24's built-in [`node:sqlite`](https://nodejs.org/docs/latest-v24.x/api/sqlite.html) (`DatabaseSync`, release candidate since 24.15). There is no native npm dependency. The parts of its API used, all present in Node 24: `new DatabaseSync(path, { timeout, readOnly, enableForeignKeyConstraints })`, `prepare()`, `StatementSync.all()/run()/columns()` (declared types of result columns, v23.11), numbered parameters `?NNN`, `database.function()` for user-defined SQL functions (v23.5), and `isTransaction`.

Every connection is opened with `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON` and `busy_timeout=5000`.

## The executor interface

Unchanged. Call sites keep using what `src/lib/db/connection.ts` gives them:

- `getDb()` returns a pool with `query(text, params) => Promise<{ rows, rowCount }>` and `connect()`. On SQLite it is a `SqlitePool` (`src/lib/db/sqlite/pool.ts`) whose shape matches the part of `pg.Pool` the app uses (`query`, `connect`, `end`, `on`), typed as `pg.Pool` so not one type annotation at a call site changes.
- `connect()` returns a client with `query()` and `release()`.
- `withTransaction(run)`, `afterCommit()`, `queryOne()`, `queryMany()` and `replaceDbPoolForTests()` are unchanged and work on both backends, because the SQLite client understands `BEGIN`, `COMMIT` and `ROLLBACK` the way `withTransaction` sends them.

The SQL the app sends is Postgres SQL on both backends. The SQLite pool translates it (next section).

## How SQLite runs Postgres SQL

Adapter-level compatibility, not call-site edits. Three layers, in `src/lib/db/sqlite/`:

### 1. User-defined functions with Postgres names (`functions.ts`)

Registered on every SQLite connection the app opens:

| Postgres                                     | On SQLite                                                                                                                                                                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `now()`                                      | ISO-8601 UTC text, `YYYY-MM-DDTHH:MM:SS.sssZ`. One value per statement outside a transaction and one per transaction inside one (the time `BEGIN IMMEDIATE` ran), as in Postgres. SQLite would otherwise evaluate it per row. |
| `gen_random_uuid()`                          | `crypto.randomUUID()`.                                                                                                                                                                                                        |
| `pg_advisory_xact_lock(k)`                   | Statements that only take a lock are handled by the pool itself (see [locks](#advisory-locks)). Anywhere else, a no-op.                                                                                                       |
| `pg_try_advisory_xact_lock(k)`               | As above; anywhere else returns true.                                                                                                                                                                                         |
| `hashtextextended(t, seed)`                  | A stable 52-bit hash. Only ever used as a lock key.                                                                                                                                                                           |
| `greatest(...)`, `least(...)`                | Postgres semantics: NULL arguments are ignored (SQLite's `max(a, b)` would return NULL).                                                                                                                                      |
| `left(s, n)`, `right(s, n)`                  | As in Postgres, including negative `n`.                                                                                                                                                                                       |
| `encode(b, 'hex'/'base64')`, `sha256(b)`     | As in Postgres (used by tests).                                                                                                                                                                                               |
| `jsonb_set(j, path, v)`                      | As in Postgres for object keys and array indexes.                                                                                                                                                                             |
| `cardinality(a)`, `array_length(a, 1)`       | Length of the JSON array.                                                                                                                                                                                                     |
| `date_trunc(unit, t)`                        | On ISO text and on epoch numbers.                                                                                                                                                                                             |
| `pg_epoch(t)`                                | What `EXTRACT(EPOCH FROM t)` is rewritten to.                                                                                                                                                                                 |
| `pg_interval_add(t, '±n unit')`              | What `t ± interval 'n unit'` is rewritten to.                                                                                                                                                                                 |
| `pg_int(x)`                                  | What `x::int` / `x::bigint` is rewritten to: rounds half away from zero, as a Postgres cast does (SQLite's `CAST` truncates).                                                                                                 |
| `pg_regexp_substring(s, re)`                 | What `substring(s from 'regex')` is rewritten to.                                                                                                                                                                             |
| `current_database()`, `pg_lock_waiters(...)` | For the two catalog views below.                                                                                                                                                                                              |

`jsonb_build_object` is rewritten to SQLite's own `json_object`, and `jsonb_strip_nulls(jsonb_build_object(...))` in the trigger to `json_patch('{}', json_object(...))`.

### 2. A mechanical rewriter for syntax SQLite lacks (`rewrite.ts`)

A small tokenizer (string literals, quoted identifiers, comments and dollar-free SQL; the app never uses `$$` in queries) and a handful of token-level rewrites. Output is cached by SQL text, so each distinct statement is rewritten once per process.

| Postgres                                                                     | SQLite                                                                    |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `$1`                                                                         | `?1` (numbered, so a parameter used twice binds once)                     |
| `x::int`, `x::bigint`, `x::integer`                                          | `pg_int(x)`                                                               |
| `x::text`                                                                    | `CAST(x AS TEXT)`                                                         |
| `x::numeric`, `x::float8`, `x::real`, `x::double precision`                  | `CAST(x AS REAL)`                                                         |
| `x::jsonb`, `x::json`, `x::text[]`, `x::timestamptz`, …                      | `x` (stored representation is already right)                              |
| `public.table`                                                               | `table`                                                                   |
| `FOR UPDATE [OF …] [SKIP LOCKED / NOWAIT]`, `FOR SHARE`, `FOR NO KEY UPDATE` | removed: the whole transaction holds the write lock (below)               |
| `x = ANY($n)`, `x = ANY(expr)`                                               | `x IN (SELECT value FROM json_each(expr))`, arrays travel as JSON         |
| `x <> ALL($n)`                                                               | `x NOT IN (SELECT value FROM json_each(expr))`                            |
| `unnest($n) AS a`                                                            | `(SELECT value AS a FROM json_each(?n)) AS a`                             |
| `ARRAY(SELECT e FROM …)`                                                     | `(SELECT json_group_array(e) FROM …)`, ORDER BY kept inside the aggregate |
| `ARRAY[a, b]`                                                                | `json_array(a, b)`                                                        |
| `EXTRACT(EPOCH FROM x)`                                                      | `pg_epoch(x)`                                                             |
| `x ± interval 'n unit'`                                                      | `pg_interval_add(x, '±n unit')`                                           |
| `position(a IN b)`                                                           | `instr(b, a)`                                                             |
| `substring(s FROM 'regex')`                                                  | `pg_regexp_substring(s, 'regex')`                                         |
| `generate_series(a, b) AS n`                                                 | a recursive CTE subquery named `n` with column `n`                        |
| `row_to_json(alias)`                                                         | `json_object('col', alias.col, …)` from the table's columns               |
| `jsonb_build_object(…)`                                                      | `json_object(…)`                                                          |
| `BEGIN ISOLATION LEVEL …`, `BEGIN READ ONLY`                                 | `BEGIN` (see below)                                                       |

Left as they are because SQLite (3.49+ in Node 24) has them: `RETURNING`, `ON CONFLICT … DO UPDATE/NOTHING` with `EXCLUDED`, `UPDATE … FROM`, CTEs, `count(*) FILTER (WHERE …)`, `string_agg(x, sep ORDER BY …)`, `IS [NOT] DISTINCT FROM`, `NULLS FIRST/LAST`, `TRUE/FALSE`, `->` and `->>` on JSON text, `||`, `COALESCE`, `NULLIF`, `lower`, `round`, `floor`, `ceil`.

Anything the rewriter recognizes as Postgres but cannot translate (`DISTINCT ON`, `LATERAL`, `ILIKE`, `SIMILAR TO`, regex operators, `ON CONFLICT ON CONSTRAINT`, `DELETE … USING`, `::regclass`, an unknown cast) throws `UnsupportedSqlError` naming the construct. It never passes SQL through half-translated.

**Every SQL string in the app is checked in CI.** `src/lib/db/sqlite/sql-corpus.ts` parses every non-test source file under `src/` and `scripts/` with the TypeScript compiler and collects every string or template literal that is a SQL statement. Interpolations are resolved where they are constants (same file or imported) or calls to helpers the corpus knows (`buildInClausePlaceholders`, `readableEnvelopeCondition`, …), by importing and calling them. `rewrite.test.ts` then rewrites each one and **prepares** it against a fresh database built from the SQLite baseline schema, which checks syntax, every table, column and function, and that each `ON CONFLICT` target matches a unique index. A statement the corpus cannot resolve must be listed, with a reason, in `sql-corpus-exceptions.ts`, and an exception that no longer matches anything fails too. So a new upstream query the rewriter cannot handle fails CI loudly, and does not wait to misbehave in production.

### 3. Call-site edits, where neither works

None in application code. See [Merge friction](#merge-friction) for the infrastructure files touched.

## Types

What the app reads must be exactly what `pg` returns today (`connection.ts` sets one parser: `bigint` → `number`). Storage on SQLite:

| Postgres column type | SQLite declared type | Stored as                                                    | Read back as (same as `pg`) |
| -------------------- | -------------------- | ------------------------------------------------------------ | --------------------------- |
| `text`               | `TEXT`               | text                                                         | string                      |
| `integer`, `bigint`  | `INTEGER`, `BIGINT`  | integer                                                      | number                      |
| `real`               | `REAL`               | real                                                         | number                      |
| `boolean`            | `BOOLEAN`            | 0 / 1                                                        | boolean                     |
| `timestamptz`        | `TIMESTAMPTZ`        | text `YYYY-MM-DDTHH:MM:SS.sssZ`, so text order is time order | `Date`                      |
| `jsonb`              | `JSONB`              | JSON text                                                    | parsed value                |
| `text[]`             | `TEXT[]`             | JSON array text                                              | `string[]`                  |
| `bytea`              | `BYTEA`              | blob                                                         | `Buffer`                    |

Parameters are converted on the way in: `Date` → ISO text in that exact format, `boolean` → 0/1, arrays and plain objects → JSON text, `undefined` → NULL.

Results are converted by the declared type of each result column (`StatementSync.columns()`, which follows a column through aliases, CTEs, subqueries and `RETURNING`). Computed columns have no declared type, so the rewriter infers a type for each select-list item from its expression and the adapter applies it only when SQLite has none:

- boolean: `EXISTS`, `NOT …`, comparisons, `IS [NOT] NULL`, `IN`, `LIKE`, `BETWEEN`, `AND`/`OR`, `true`/`false`, `x::boolean`, `bool_or`/`bool_and`/`every`, the advisory-lock functions;
- JSON: `json_object`/`jsonb_build_object`, `ARRAY(…)`, `json_group_array`, `->`, `x::jsonb`, `x::text[]`, `jsonb_set`, `row_to_json` (unless cast to text);
- `Date`: `now()`, `x::timestamptz`, interval arithmetic;
- the type of the first argument for `COALESCE`, `NULLIF`, `MAX`, `MIN`, `GREATEST`, `LEAST`, and of the first `THEN` of a `CASE`, where that argument is a column whose declared type is the same in every table that has it (the adapter reads the schema once).

`count(*)` and arithmetic come back as numbers on both backends. Two known differences, both checked against the app and harmless there, and listed in the tests: `->>` returns a JSON number as a number where Postgres returns text (the app only reads strings this way), and SQLite's `lower()` folds ASCII only (addresses are compared lowercased on both sides, so a non-ASCII address still matches itself).

Errors are given the Postgres `code` the app checks: `42P01` (no such table), `42703` (no such column), `23505` (unique), `23503` (foreign key), `23514` (check, and the approver trigger), `23502` (not null), `40P01` (deadlock between locks, below), `55P03` (lock timeout). `isMissingSchemaError` and `isUniqueViolation` work unchanged.

## Transactions and concurrency

One process, one writer.

- The pool holds one writer connection and one reader connection (read-only) to the same file, in WAL mode.
- **A transaction holds an in-process async mutex from its first statement to `COMMIT`/`ROLLBACK`**, and runs `BEGIN IMMEDIATE` when it takes it. Call sites `await` between statements, so other async work runs meanwhile; the mutex makes sure none of it is a statement of another transaction. `BEGIN` itself only marks the client as in a transaction: the mutex is taken by the first real statement, so a transaction that only holds an advisory lock (the cleanup job and directory sync hold one for their whole run while working through the pool) does not stop everyone else.
- A statement through the pool, outside a transaction: a write takes the mutex for that one statement; a read (`SELECT`, or `WITH` with no `INSERT`/`UPDATE`/`DELETE`) runs on the reader connection without waiting, and sees everything committed, which is what READ COMMITTED gives on Postgres. The reader is opened read-only, so a statement wrongly taken for a read fails loudly instead of writing outside the lock.
- The mutex is FIFO. A wait longer than `SQLITE_LOCK_TIMEOUT_MS` (30 s) fails with `55P03` and a message saying a transaction has held the database that long, rather than hanging: the usual cause is a write through the pool from inside a transaction, which would wait for itself.

**Why stripping `FOR UPDATE` / `SKIP LOCKED` / `FOR SHARE` is safe.** On Postgres those clauses make two transactions that touch the same rows take turns at the row. Here no two transactions run at the same time at all: from its first statement to its commit, a transaction holds the only write lock in the only process (single-instance is enforced by the deployment, below), and every statement of another transaction waits for it. So a row read in a transaction cannot change until that transaction ends, which is everything `FOR UPDATE` and `FOR SHARE` promise, and there is never a locked row to skip, so `SKIP LOCKED` has nothing to do. Isolation is in fact stronger than Postgres's READ COMMITTED: every transaction is serializable. Code written for READ COMMITTED (retry on a lost race, re-read after a lock) stays correct under serializable execution. Reads outside a transaction see committed data only, as on Postgres.

### Advisory locks

`pg_advisory_xact_lock(k)` and `pg_try_advisory_xact_lock(k)` serialize jobs (cleanup, directory sync, backup, setup) and some read-check-write sequences (role changes, the audit chain). A statement that only takes such a lock (`SELECT pg_[try_]advisory_xact_lock(<expr>) [AS x]`) is answered by the pool from an in-process lock table, with Postgres semantics: held by that client until its transaction ends; `try` returns false if another client holds it; the blocking form waits.

- The blocking form first takes the transaction's write mutex, then the key. Every blocking user of a key therefore already holds the mutex, so two of them never wait on each other.
- The `try` form does not take the mutex. That is what lets the cleanup job hold its lock for an hour while its work goes through the pool.
- The only possible cycle is a mutex holder waiting for a key held by a transaction that is itself waiting for the mutex. The pool detects it and fails one side with `40P01`, as Postgres's deadlock detector does. No key in the app is used both ways, so it does not happen in practice.

### Single instance

Correctness depends on one process. The deployment enforces it: Cloud Run `--max-instances=1`, and the GCS lease described below, which also covers the moment during a deploy when Cloud Run runs the old and new revisions side by side. The SQLite file must never be opened for writing by a second process while the app runs, other than by Litestream, which only reads it and checkpoints the WAL.

## Schema and migrations

- `db/migrations/*.sql` (Postgres) are untouched.
- `db/sqlite/baseline.sql` is the schema all of those migrations produce, translated to SQLite: same tables, columns, defaults, `CHECK` constraints, foreign keys, unique and partial indexes, and the two PL/pgSQL triggers rewritten as SQLite triggers (`fields_not_for_approvers` as two `BEFORE` triggers that `RAISE(ABORT, …)`, `audit_events_queue_notification` as an `AFTER INSERT` trigger). Defaults use only SQLite built-ins (`unixepoch()`, `strftime('%Y-%m-%dT%H:%M:%fZ')`, `randomblob`), so the file can be written by any SQLite client, not only one with the app's functions registered.
- `db/sqlite/baseline.versions` lists the Postgres migrations the baseline stands for.
- `db/sqlite/migrations/<same name as the Postgres migration>.sql` holds the SQLite version of each later Postgres migration.
- `db/migrate.mjs` keeps its interface. With a `sqlite:` URL, `runMigrations` hands over to `db/sqlite/migrate.mjs`, which takes an exclusive lock on the file, creates `signudoc_migrations`, applies the baseline to an empty database (recording every version in `baseline.versions`), then each file in `db/sqlite/migrations` not yet recorded, each in its own transaction. Versions recorded are the Postgres migration names on both backends, which is what lets a backup taken on one backend be restored on the other.

CI checks (`db/sqlite/migrations.test.mjs`): every Postgres migration is either in `baseline.versions` or has a counterpart in `db/sqlite/migrations`, and nothing in either list is not a Postgres migration. `src/lib/db/sqlite/schema-parity.dbtest.ts` (run in the Postgres `test:db` job) migrates both and compares every table, column, column type class and nullability.

**Contributor rule:** every schema change needs a Postgres migration in `db/migrations` and a SQLite migration with the same file name in `db/sqlite/migrations`. CI fails without it.

## Better Auth

Better Auth 1.7 supports SQLite through Kysely, including a `node:sqlite` dialect. Its own dialect cannot be used here: it would run statements on the shared connection without the pool's mutex, so a Better Auth write could land inside an app transaction (or start one inside it). Instead `src/lib/db/sqlite/kysely.ts` is a small Kysely dialect that uses Kysely's SQLite query compiler, adapter and introspector, and runs every statement through the SQLite pool's clients, so Better Auth shares the mutex, the reader connection and the type conversion. `createAppAuth` passes `{ dialect, type: "sqlite", transaction: true }` instead of the pool. With `type: "sqlite"` Better Auth writes dates as `toISOString()` and booleans as 0/1, the same representation as the rest of the app.

This adds `kysely` as a direct dependency. It is already installed (Better Auth depends on it, same version) and is pure JavaScript; the only change is that it is declared.

## Tests and CI

- `npm test` (unit, no database) adds: the rewriter against every SQL string in the app (above), the rewriter's rules one by one, the functions, type round trips (including that ISO timestamps sort as times, and `Date` → text → `Date` is exact to the millisecond), the mutex under many concurrent async transactions (no interleaving, FIFO, timeout), advisory lock semantics and deadlock detection, the migrations list check, and the GCS lease (against a fake).
- `npm run test:db` runs on both backends. `openTestDatabase()` (`src/lib/db/test-database.ts`) returns a fresh SQLite file in a temporary directory per call when `E2E_DATABASE_URL` is a `sqlite:` URL (or `TEST_DB_BACKEND=sqlite`). The race tests ask Postgres who is waiting (`pg_locks`, `pg_stat_activity`); on SQLite those two names are views over the pool's own lock table (`pg_lock_waiters()`), so the same tests run unchanged.
- The e2e test (Playwright) runs on both: the server gets `DATABASE_URL=sqlite:…`, and the specs open the same file through `e2e/support/database.ts` instead of `new pg.Pool`. The SQLite file is shared by two processes there (server and test runner), which SQLite's own file locking handles.
- `.github/workflows/ci.yml`: the `e2e` job becomes a matrix over `postgres` and `sqlite` (the Postgres service only matters to the first); the Docker job also starts the image with a SQLite database and checks it migrates itself at start and answers.

## Durability on Cloud Run with Litestream

Cloud Run's disk is memory and disappears with the instance. The database lives in that memory; Litestream copies every committed page to a GCS bucket within about a second, and the next instance starts from that copy.

**Start** (`db/sqlite/start.mjs`, run by the image when `DATABASE_URL` is `sqlite:` and `LITESTREAM_REPLICA_URL=gs://bucket/path` is set):

1. Take the lease (below).
2. `litestream restore -if-db-not-exists -if-replica-exists <file>`: the latest state from GCS, or nothing on a first deploy.
3. Run the migrations in-process.
4. `litestream replicate -exec "node server.js"` with a generated config: `sync-interval: 1s`, snapshots every 24 h kept 7 days, `shutdown-sync-timeout` within Cloud Run's 10 s grace. GCS credentials are Application Default Credentials, the runtime service account; no key.

Without `LITESTREAM_REPLICA_URL` (local Docker, a VM with a disk) it runs the migrations and starts the server. With a Postgres URL the image starts `node server.js` as before.

**RPO.** A commit is durable on the instance's disk at once (`synchronous=FULL`) and in GCS within about one second (Litestream's sync interval, configurable). Losing the instance without warning can lose that last second. A normal stop (scale to zero, deploy, a crash of the app process) loses nothing: Cloud Run sends SIGTERM, Litestream forwards it to the server, waits for it to exit, then syncs the WAL to GCS before exiting.

**Cold start.** From zero: lease, restore (one snapshot plus the changes since, typically well under a second for a small install), migrations, server start. A few seconds.

**Single instance.** `--max-instances=1` keeps one instance per revision, but during a deploy Cloud Run runs the old and the new revision at the same time for a while, and two writers would fork the data. So the start script takes a lease, an object next to the replica (`<path>.lease`) written with GCS generation preconditions:

- It is created only if absent, refreshed every 10 s by its holder, and deleted after Litestream's final sync.
- A new instance that finds it held waits, answering `/api/health` with 200 and everything else with 503 and `Retry-After`, so the deploy goes ahead and traffic moves to it. If the holder is an older revision (lower revision number), the newcomer asks it to hand over (writes `handoverTo` into the lease); the holder stops its server, lets Litestream finish its final sync, deletes the lease and exits. The newcomer restores from what the holder just synced, so nothing written to the old revision is lost. Requests in those seconds get a 503 with `Retry-After`.
- A lease nobody has refreshed for 30 s belongs to an instance that died; the next instance takes it over (by generation, so two cannot both take it).
- If a holder ever finds that its lease has been taken (it was frozen past the 30 s), it stops at once without writing further.
- Rolling back by moving traffic to an older revision would leave it waiting for the newer one to hand over, which it never does to an older revision. Roll back by deploying the older image again (a new revision); the docs say so.

**Shutdown flush.** As above: SIGTERM → server exits → Litestream's final sync (bounded so it finishes inside Cloud Run's 10 s) → lease deleted.

**Deploy settings** (`deploy/google-cloud/setup.sh`, `DB_BACKEND=sqlite`, the default): `--max-instances=1 --min-instances=0 --no-cpu-throttling --execution-environment=gen2`. CPU stays allocated while the instance is up, so Litestream keeps syncing between requests; the instance still scales to zero when idle, so idle cost is $0. No Cloud SQL, no migrate job: migrations run at start. A dedicated replica bucket `<project>-<service>-db` with object versioning and soft delete, and `roles/storage.objectAdmin` on it for the runtime service account.

## Backups

Two layers on SQLite:

- **Litestream** is the database's continuous backup: point-in-time restore to any moment in the retention window (`litestream restore -timestamp …`), plus the bucket's object versioning and soft delete.
- **SignuDoc's own backup** (Settings, Backups, or `BACKUP_GCS_BUCKET`) works unchanged on SQLite and keeps its format: the existing table export (`database/*.ndjson.gz`, one JSON line per row) rather than a `VACUUM INTO` copy of the file. The export is read in one snapshot on a separate read-only connection, so it does not hold up writers, and every value is written in the same JSON form Postgres's `row_to_json` produces (booleans, timestamps, nested JSON). Chosen because it is the same file whichever backend wrote it, so `scripts/restore-backup.ts` restores a SQLite backup into Postgres and the other way round, which is the [switch](#switching-backends-later).

## Switching backends later

SQLite to Postgres (or back) is a backup and a restore, with the tools that already exist:

1. Make sure a SignuDoc backup is configured, and run one (Settings, Backups, Run now, or `POST /api/internal/backup`). Stop writes: scale the service to zero or put it in maintenance (`--max-instances=0` is enough on Cloud Run) after the backup.
2. Create the Postgres database and run the migrations against it (`DATABASE_URL=postgres://… npm run db:migrate`).
3. `DATABASE_URL=postgres://… BACKUP_GCS_BUCKET=… npm run restore-backup` (see docs/backup-and-restore.md). It refuses a database that already has accounts, checks the migrations match, and loads every table in one transaction.
4. Point the deployment at Postgres: `DB_BACKEND=postgres ./deploy/google-cloud/setup.sh`.

`docs/google-cloud-run.md` has the exact commands.

## Merge friction

Application code: **no SQL call site is changed.** Upstream-owned files touched, and why:

| File                                                                               | Change                                                                                                                        |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/db/connection.ts`                                                         | `getDb()` opens a `SqlitePool` for a `sqlite:` URL (a few lines at the top of the function). Nothing else.                    |
| `src/lib/db/test-database.ts`                                                      | `openTestDatabase()` returns a fresh SQLite database on the SQLite backend (a few lines at the top).                          |
| `db/migrate.mjs`                                                                   | `runMigrations()` hands a `sqlite:` URL to `db/sqlite/migrate.mjs` (three lines).                                             |
| `src/lib/auth/server.ts`                                                           | `database` passed to Better Auth through `betterAuthDatabase(database)` (one line plus an import).                            |
| `e2e/global-setup.ts`                                                              | Wipes and migrates a SQLite file instead of a Postgres schema when the URL is `sqlite:`.                                      |
| `e2e/platform.spec.ts`, `e2e/signing-flow.spec.ts`, `e2e/google-workspace.spec.ts` | `new pg.Pool/Client({ connectionString })` → `openE2eDatabase()` (one line each place; the specs use `query` and `end` only). |
| `package.json`, `package-lock.json`                                                | `kysely` declared.                                                                                                            |

Fork-owned files touched: `src/lib/backup.ts` (dispatch to the SQLite export/restore), `scripts/restore-backup.ts`, `scripts/copy-migrate-packages.mjs` (none needed: `node:sqlite` is built in), `Dockerfile`, `.github/workflows/ci.yml`, `.github/workflows/deploy-cloud-run.yml`, `deploy/google-cloud/*`, `docs/*`. Everything else is new files under `src/lib/db/sqlite/`, `db/sqlite/` and `e2e/support/`.

When upstream adds a query, nothing needs doing unless CI's corpus test fails, in which case the fix goes in the rewriter or the functions, not at the call site. When upstream adds a migration, the SQLite counterpart is the only new file.

## Deviations from the brief

- **Casts are translated, not stripped.** `::int` becomes `pg_int(x)` and `::text` becomes `CAST(x AS TEXT)` rather than disappearing, because a stripped cast changes results: `(a / b)::int` rounds on Postgres, and `id::text = $1` compares as text. Only casts whose stored representation is already right (`::jsonb`, `::text[]`, `::timestamptz`, …) are removed.
- **`BEGIN` is deferred to the first statement**, and pool reads outside a transaction use a separate read-only connection. With the mutex taken at `BEGIN`, the cleanup job and directory sync (which hold an advisory lock in an otherwise idle transaction while their work goes through the pool) would wait for themselves forever.
- **Advisory locks are real in-process locks**, not no-ops. The jobs rely on `pg_try_advisory_xact_lock` returning false while another run holds the lock; a no-op returning true would let two cleanups run at once.
- **Computed column types are inferred** by the rewriter rather than by an alias-suffix convention, which would have meant editing call sites.
- **A GCS lease** guards against two instances during a deploy. `--max-instances=1` alone does not prevent it, and losing writes made to the old revision would break priority 1.
- **`kysely` becomes a declared dependency** for Better Auth (above).

## Further simplification, not done

Kept out to avoid touching upstream call sites; worth doing upstream, or if the fork ever stops merging weekly:

- Replace the scattered `FOR UPDATE`/advisory-lock patterns with one `withLockedEnvelope(id, fn)` helper; on SQLite it would be a no-op wrapper.
- One `DbExecutor` type instead of `DbPool | PoolClient | Pick<…>` variants across modules.
- Store app timestamps as `timestamptz` everywhere (they are epoch seconds in `bigint` columns, while Better Auth's are `timestamptz`), so there is one time representation.
- Generate `db/sqlite/baseline.sql` from the Postgres schema with a script instead of by hand, once there are enough SQLite migrations to make re-baselining worth it.
