-- The Cloud project the administrator chose during the automatic Google
-- Workspace setup. The run waits for it while the page sends it from
-- another request, which can reach another instance, so it is passed
-- through here. A row lives seconds; one nobody took is removed after an
-- hour. choice is JSON: {"create":true} or {"create":false,"projectId":...}.

create table if not exists public.google_setup_choices (
  run_id text primary key,
  user_id text not null,
  choice text not null,
  created_at bigint not null
);
