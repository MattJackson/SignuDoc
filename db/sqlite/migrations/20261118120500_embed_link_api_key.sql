-- SQLite version of db/migrations/20261118120500_embed_link_api_key.sql:
-- the API key that asked for a signer's current embedded link. A nullable
-- column with a foreign key and no default is allowed by ADD COLUMN.

alter table signers add column embed_api_key_id text
  references api_keys (id) on delete set null;
