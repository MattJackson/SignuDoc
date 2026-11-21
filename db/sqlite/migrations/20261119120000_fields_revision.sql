-- SQLite version of db/migrations/20261119120000_fields_revision.sql: how
-- many times a draft's field list has been saved.

alter table envelopes add column fields_revision integer not null default 0;
