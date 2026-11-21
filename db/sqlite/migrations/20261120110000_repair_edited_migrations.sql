-- SQLite version of db/migrations/20261120110000_repair_edited_migrations.sql.
-- The Postgres file adds columns that earlier migrations gained after they
-- were published. On SQLite there is nothing to repair: no database has run
-- an earlier copy of these files, and every column is already in its final
-- shape:
--   * scheduled_envelope_deletions: all columns are in
--     20261118110000_scheduled_envelope_deletions.sql.
--   * pending_file_deletions.last_tried_at: in baseline.sql.
--   * bulk_send_batches.claim_token, claimed_at: in
--     20261118090000_bulk_send_batches.sql.
-- SQLite has no ADD COLUMN IF NOT EXISTS, so only the index change, which
-- is idempotent, is applied.

drop index if exists pending_file_deletions_queued_at_idx;

create index if not exists pending_file_deletions_order_idx
  on pending_file_deletions (last_tried_at, queued_at);
