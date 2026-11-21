-- SQLite version of db/migrations/20261118100500_api_idempotency_resource.sql:
-- the envelope an idempotent request made. api_idempotency is created by
-- 20261118100000_api_envelopes.sql, so the column is never there yet.

alter table api_idempotency add column resource_id text;
