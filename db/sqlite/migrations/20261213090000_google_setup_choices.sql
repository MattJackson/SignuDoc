-- SQLite version of db/migrations/20261213090000_google_setup_choices.sql.

create table if not exists google_setup_choices (
  run_id text not null,
  user_id text not null,
  choice text not null,
  created_at integer not null,
  primary key (run_id, user_id)
);
