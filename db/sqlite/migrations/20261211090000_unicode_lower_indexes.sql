-- SQLite version of db/migrations/20261211090000_unicode_lower_indexes.sql.
-- Every connection now defines lower() to fold every letter, as Postgres
-- does (SQLite's own folds ASCII only), so the three indexes on lower(...)
-- are rebuilt with it. Rows that are distinct under the old lower() but equal
-- under the new one (a team 'Équipe' next to 'équipe') would stop the unique
-- index from being built, so they are told apart first, by their order of
-- creation. Nothing is deleted, and with no such rows nothing changes.
--
-- The indexes go first: an index entry is found again by computing its key
-- from the row, so a row cannot be updated under an index built with the
-- other function.

drop index if exists idx_signers_envelope_email;
drop index if exists teams_name_unique;
drop index if exists teams_google_group_email_unique;

-- Each row's place among the rows that are now the same, worked out before
-- anything changes.
create temp table unicode_lower_places (
  kind text not null,
  row_id integer not null,
  place integer not null
);

insert into unicode_lower_places
  select 'name', rowid, row_number() over (partition by lower(name) order by rowid)
  from teams;
insert into unicode_lower_places
  select 'group', rowid, row_number() over (partition by lower(google_group_email) order by rowid)
  from teams
  where google_group_email is not null;
insert into unicode_lower_places
  select 'email', rowid, row_number() over (partition by envelope_id, lower(email) order by rowid)
  from signers;

-- The later team gets a number: 'équipe' becomes 'équipe (2)'.
update teams
set name = substr(name, 1, 70) || ' (' || (
  select place from unicode_lower_places
  where kind = 'name' and row_id = teams.rowid
) || ')'
where rowid in (
  select row_id from unicode_lower_places where kind = 'name' and place > 1
);

-- A group address can belong to one team: the later team goes without.
update teams
set google_group_email = null
where rowid in (
  select row_id from unicode_lower_places where kind = 'group' and place > 1
);

-- An address can be on an envelope once: the later signer's gets '+dup2'
-- (and so on) before the @.
update signers
set email = substr(email, 1, instr(email, '@') - 1) || '+dup' || (
  select place from unicode_lower_places
  where kind = 'email' and row_id = signers.rowid
) || substr(email, instr(email, '@'))
where rowid in (
  select row_id from unicode_lower_places where kind = 'email' and place > 1
);

drop table unicode_lower_places;

create unique index idx_signers_envelope_email on signers (envelope_id, lower(email));
create unique index teams_name_unique on teams (lower(name));
create unique index teams_google_group_email_unique on teams (lower(google_group_email))
  where google_group_email is not null;
