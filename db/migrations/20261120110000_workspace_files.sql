-- Files from the organization's workspace (src/lib/workspace): each
-- person's own connection to their files, for starting an envelope from
-- one, and the copies of completed envelopes kept in a shared location.
-- Both stay empty until an administrator sets the parts up.
--
-- * workspace_file_connections: one row per person and provider, holding
--   the refresh token the provider gave when the person connected (for
--   Google, the drive.file scope: only files the person picks, or that the
--   app makes itself). The token is encrypted with a key derived from
--   BETTER_AUTH_SECRET and the person's id, and never leaves the server;
--   access tokens are made from it when needed and not stored.
--   Disconnecting revokes it and deletes the row; a deleted account takes
--   its rows with it.
--
-- * workspace_exports: an outbox. A row is written in the same transaction
--   that marks an envelope completed, while a destination is chosen, so a
--   completion is never missed. The copy is tried right after the commit
--   and again by /api/internal/workspace-export, with a growing wait
--   between tries and a limit on how many. A row that reached the limit is
--   'failed' and waits for an administrator to try it again. The provider
--   finds what an earlier try made (by the envelope's id and each file's
--   SHA-256), so a retry never makes a second copy.

create table if not exists public.workspace_file_connections (
  user_id text not null references public."user"(id) on delete cascade,
  provider text not null,
  -- The provider's id for the account that agreed, and its address.
  account_id text not null,
  account_email text not null,
  refresh_token text not null,
  scope text not null,
  created_at bigint not null,
  updated_at bigint not null,
  primary key (user_id, provider)
);

create table if not exists public.workspace_exports (
  envelope_id text primary key references public.envelopes(id) on delete cascade,
  -- Where the copies go, as chosen when the envelope was completed.
  destination text not null,
  status text not null default 'pending'
    check (status in ('pending', 'exported', 'failed')),
  attempts integer not null default 0,
  next_attempt_at bigint not null,
  locked_until bigint,
  last_error text,
  -- What the provider made: [{ "id", "kind", "url" }].
  exported_files jsonb,
  -- Why labels or other metadata could not be put on the copy, if so.
  metadata_problem text,
  created_at bigint not null,
  updated_at bigint not null,
  exported_at bigint
);

-- What the retry job asks for: rows still to send, soonest first.
create index if not exists workspace_exports_due_idx
  on public.workspace_exports (next_attempt_at)
  where status = 'pending';

create index if not exists workspace_exports_created_idx
  on public.workspace_exports (created_at desc);
