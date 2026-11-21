-- SQLite version of db/migrations/20261118090000_api_keys.sql: API keys for
-- the public API. Only a SHA-256 hash of a key is kept. See that file for
-- what each column is.

create table if not exists api_keys (
  id text not null primary key,
  user_id text not null references "user" (id) on delete cascade,
  name text not null check (length(name) between 1 and 80),
  prefix text not null,
  key_hash text not null unique check (length(key_hash) = 64),
  scope text not null check (scope in ('read', 'write')),
  created_at bigint not null,
  last_used_at bigint,
  expires_at bigint,
  revoked_at bigint
);

create index if not exists api_keys_user_id_idx
  on api_keys (user_id);
