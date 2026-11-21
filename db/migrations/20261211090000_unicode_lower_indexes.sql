-- Nothing to do on Postgres, whose lower() folds every letter already. The
-- SQLite version (db/sqlite/migrations) rebuilds the unique index on
-- lower(teams.name) for the lower() every SQLite connection now defines, and
-- keys the signer and group address indexes with COLLATE NOCASE, since
-- SQLite's own lower() folded ASCII only.
select 1;
