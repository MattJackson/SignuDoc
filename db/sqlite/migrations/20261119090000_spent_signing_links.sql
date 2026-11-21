-- SQLite version of db/migrations/20261119090000_spent_signing_links.sql:
-- the hash of the signing link a signer last held, kept once it is spent.

alter table signers add column spent_signing_token_hash text;

create index if not exists idx_signers_spent_signing_token_hash
  on signers (spent_signing_token_hash)
  where spent_signing_token_hash is not null;
