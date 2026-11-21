// What the SQL corpus (sql-corpus.ts) cannot work out by itself.
//
// STAND_INS: interpolations in SQL that are not constants, keyed by their
// source text with whitespace collapsed. The value is what the
// interpolation produces in a typical call (a function to call the real
// helper where it is exported). rewrite.test.ts fails on an interpolation
// that has no stand-in here, and on a stand-in that nothing uses any more.
//
// POSTGRES_ONLY: statements that only ever run on Postgres, because the
// code around them sends something else on SQLite. The test fails on an
// entry that matches nothing.
import {
  envelopeScopeCondition,
  readableEnvelopeCondition,
} from "../../envelope-access.ts";

export const STAND_INS: Record<string, string | (() => string)> = {
  'readableEnvelopeCondition("$1")': () => readableEnvelopeCondition("$1"),
  'envelopeScopeCondition("team", "$1")': () =>
    envelopeScopeCondition("team", "$1"),
  // envelopes.ts: buildInClausePlaceholders(n, start) is "$start, …".
  "buildInClausePlaceholders(envelopeIds.length)": "$1, $2",
  "buildInClausePlaceholders(nextSigners.length, 2)": "$2, $3",
  // envelopes.ts, listEnvelopesForUser: every filter at once.
  'clauses.join(" AND ")': `${envelopeScopeCondition("all", "$1")} AND status = $2 AND (lower(title) LIKE $3 ESCAPE '\\' OR EXISTS (SELECT 1 FROM signers WHERE signers.envelope_id = envelopes.id AND lower(signers.email) LIKE $3 ESCAPE '\\') OR EXISTS (SELECT 1 FROM public."user" sender WHERE sender.id = envelopes.user_id AND (lower(sender.email) LIKE $3 ESCAPE '\\' OR lower(sender.name) LIKE $3 ESCAPE '\\')))`,
  // api/envelope-view.ts, listApiEnvelopes: the status filter and a cursor.
  'src/lib/api/envelope-view.ts|clauses.join(" AND ")':
    "e.user_id = $1 AND e.status = $2 AND (e.created_at, e.id) < ($3, $4)",
  "String(values.length)": "5",
  limitPlaceholder: "$4",
  offsetPlaceholder: "$5",
  // envelope-deletion.ts: how many scheduled deletions one run takes.
  "String(SCHEDULED_DELETIONS_PER_RUN)": "100",
  // retention.ts: one "$n" per envelope.
  'envelopeIds .map((_, index) => `$${String(index + 1)}`) .join(", ")':
    "$1, $2",
  // settings.ts: settingsColumnsAfter(n) lists the settings columns the
  // first n later migrations had added; the newest shape is the widest.
  "settingsColumnsAfter(laterMigrations)":
    "allowed_email_domains, email_ready_at, organization_name, privacy_url, sender_address, setup_completed_at, signup_mode, support_address, terms_url, retention_days, brand_color, logo_hash, part11_mode, require_two_factor, session_idle_minutes, session_max_hours, product_name, consent_disclosure",
  "settingsColumnsAfter(LATER_SETTINGS_COLUMNS.length)":
    "allowed_email_domains, email_ready_at, organization_name, privacy_url, sender_address, setup_completed_at, signup_mode, support_address, terms_url, retention_days, brand_color, logo_hash, part11_mode, require_two_factor, session_idle_minutes, session_max_hours, product_name, consent_disclosure",
  // backup.ts: each of BACKFILLS_FOR_OLDER_BACKUPS; there is one.
  "src/lib/backup.ts|backfill.sql": `UPDATE "user" SET identity_verified_name = name, identity_verified_email = email WHERE identity_verified_at IS NOT NULL AND identity_verified_name IS NULL`,
};

export const POSTGRES_ONLY: {
  file: string;
  contains: string;
  reason: string;
}[] = [
  {
    contains: "information_schema.tables",
    file: "src/lib/backup.ts",
    reason: "The table list; SQLite uses src/lib/db/sqlite/backup.ts.",
  },
  {
    contains: "DECLARE",
    file: "src/lib/backup.ts",
    reason:
      "A Postgres cursor for the export; SQLite reads a snapshot instead.",
  },
  {
    contains: "FETCH",
    file: "src/lib/backup.ts",
    reason:
      "A Postgres cursor for the export; SQLite reads a snapshot instead.",
  },
  {
    contains: "CLOSE",
    file: "src/lib/backup.ts",
    reason:
      "A Postgres cursor for the export; SQLite reads a snapshot instead.",
  },
  {
    contains: "pg_constraint",
    file: "src/lib/backup.ts",
    reason: "The foreign keys between tables; SQLite reads them with PRAGMA.",
  },
  {
    contains: "DELETE FROM ",
    file: "src/lib/backup.ts",
    reason:
      "The Postgres restore empties each table; SQLite's restore does its own.",
  },
  {
    contains: "json_populate_recordset",
    file: "src/lib/backup.ts",
    reason: "The restore's bulk insert; SQLite inserts row by row.",
  },
  {
    contains: "pg_database",
    file: "src/lib/db/test-database.ts",
    reason:
      "Creates the Postgres test database; a SQLite test database is a file.",
  },
  {
    contains: "create database",
    file: "src/lib/db/test-database.ts",
    reason:
      "Creates the Postgres test database; a SQLite test database is a file.",
  },
  {
    contains: "pg_backend_pid",
    file: "src/lib/db/test-database.ts",
    reason:
      "waitUntilBlockedBy on Postgres; on SQLite it reads pg_stat_activity.",
  },
  {
    contains: "pg_blocking_pids",
    file: "src/lib/db/test-database.ts",
    reason:
      "waitUntilBlockedBy on Postgres; on SQLite it reads pg_stat_activity.",
  },
];
