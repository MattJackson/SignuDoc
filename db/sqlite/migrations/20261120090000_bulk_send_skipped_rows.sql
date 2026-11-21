-- SQLite version of db/migrations/20261120090000_bulk_send_skipped_rows.sql:
-- nothing to do. That migration widens the status CHECK on
-- bulk_send_batch_rows to allow 'skipped'. SQLite cannot replace a CHECK
-- without rebuilding the table, so 20261118090000_bulk_send_batches.sql
-- (which creates the table) already has the final CHECK.

select 1;
