-- SQLite version of db/migrations/20261120100000_identity_verified_snapshot.sql:
-- the name and email an administrator confirmed, kept with the confirmation.

alter table "user" add column identity_verified_name text;
alter table "user" add column identity_verified_email text;

-- Confirmations made before this change were of the account as it is now.
update "user"
set
  identity_verified_name = name,
  identity_verified_email = email
where identity_verified_at is not null
  and identity_verified_name is null;
