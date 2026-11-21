-- SQLite version of db/migrations/20261118120000_embedded_signing.sql:
-- embedded signing. See that file for what each column is. SQLite allows
-- ADD COLUMN with a NOT NULL default and a CHECK.

alter table envelopes add column delivery text not null default 'email'
  check (delivery in ('email', 'embedded'));

alter table signers add column embed_origin text;
alter table signers add column embed_link_opened_at bigint;

create table if not exists embed_allowed_origins (
  origin text not null primary key check (length(origin) between 8 and 255),
  created_by text references "user" (id) on delete set null,
  created_at bigint not null
);
