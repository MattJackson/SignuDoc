-- SQLite version of db/migrations/20261118100000_api_envelopes.sql: what the
-- public API keeps beyond what the web app does. SQLite has no ADD COLUMN IF
-- NOT EXISTS; none of these columns exist in the baseline or any earlier file.

alter table envelopes add column api_key_id text;
alter table envelopes add column api_metadata jsonb;

alter table signers add column api_ref text;

create table if not exists api_idempotency (
  api_key_id text not null,
  idempotency_key text not null check (length(idempotency_key) between 1 and 255),
  request_hash text not null check (length(request_hash) = 64),
  status_code integer,
  response jsonb,
  created_at bigint not null,
  primary key (api_key_id, idempotency_key)
);

create index if not exists api_idempotency_created_at_idx
  on api_idempotency (created_at);
