-- SQLite version of db/migrations/20261211090000_unicode_lower_indexes.sql.
-- Every connection now defines lower() to fold every letter, as Postgres
-- does (SQLite's own folds ASCII only). The index on lower(teams.name) is
-- rebuilt with it. Team names that are distinct under the old lower() but
-- equal under the new one (a team 'Équipe' next to 'équipe') would stop the
-- unique index from being built, so the later one has the first 8 characters
-- of its id added, after its name is cut to 60 characters: 'équipe' becomes
-- 'équipe (1a2b3c4d)'. Nothing is deleted, and with no such names
-- nothing changes.
--
-- The signer and group address indexes do not need the new function. They
-- are keyed with COLLATE NOCASE, which folds ASCII only, exactly as the old
-- lower() did, so every row the old indexes accepted is accepted again, no
-- signer or group address is touched (a signer's address is signing
-- evidence), and no connection's lower() can disagree about their keys.
--
-- The old indexes go first: an index entry is found again by computing its
-- key from the row, so a row cannot be updated under an index built with
-- the other function.

drop index if exists idx_signers_envelope_email;
drop index if exists teams_name_unique;
drop index if exists teams_google_group_email_unique;

-- Each team's place among the teams whose names are now the same, worked out
-- before anything changes. The suffix is the team's own id (its first 8 characters), so it is unlikely to meet
-- another team's name.
create temp table unicode_lower_places (
  row_id integer not null,
  place integer not null
);

insert into unicode_lower_places
  select rowid, row_number() over (partition by lower(name) order by rowid)
  from teams;

update teams
set name = substr(name, 1, 60) || ' (' || substr(id, 1, 8) || ')'
where rowid in (select row_id from unicode_lower_places where place > 1);

drop table unicode_lower_places;

create unique index idx_signers_envelope_email on signers (envelope_id, email collate nocase);
create unique index teams_name_unique on teams (lower(name));
create unique index teams_google_group_email_unique on teams (google_group_email collate nocase)
  where google_group_email is not null;
