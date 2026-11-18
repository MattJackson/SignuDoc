-- Nothing to do on Postgres, whose lower() folds every letter already. The
-- SQLite version (db/sqlite/migrations) rebuilds the indexes on lower(...)
-- for SQLite's own lower(), which folds ASCII only, having been replaced by
-- one that folds every letter.
select 1;
