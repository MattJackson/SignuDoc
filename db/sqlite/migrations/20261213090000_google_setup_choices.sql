-- SQLite version of db/migrations/20261213090000_google_setup_choices.sql.

create table if not exists google_setup_choices (
  run_id text primary key,
  user_id text not null,
  choice text not null,
  created_at integer not null
);
