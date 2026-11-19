-- A choice the administrator makes during a workspace provider's automatic
-- setup, such as the Google Cloud project to use
-- (src/lib/workspace/workspace-setup.ts). The run waits for it while the
-- page sends it from another request, which can reach another instance,
-- so it is passed through here. The run takes only the answer of the
-- person running it, so an answer from anyone else cannot take its place.
-- A row lives seconds; one nobody took is removed after an hour. Nothing
-- secret is kept here: choice is the id of the option chosen.

create table if not exists public.workspace_setup_choices (
  run_id text not null,
  user_id text not null,
  choice text not null,
  created_at bigint not null,
  primary key (run_id, user_id)
);
