-- Google Drive: each person's own Drive connection, and the copies of
-- executed envelopes sent to a Shared Drive.
--
-- * google_drive_tokens: one row per person who connected Google Drive,
--   holding the refresh token Google gave for the drive.file scope (files
--   the person opens with, or makes through, this app only). The token is
--   encrypted with a key derived from BETTER_AUTH_SECRET and never leaves
--   the server; access tokens are made from it when needed and are not
--   stored. Disconnecting revokes it at Google and deletes the row. An
--   account that is deleted takes its row with it.
--
-- * drive_exports: an outbox. A row is written in the same transaction
--   that marks an envelope completed, while a Shared Drive is chosen for
--   executed copies, so a completion can never be missed. The upload is
--   tried right after the commit and again by /api/internal/drive-export,
--   with a growing wait between tries and a limit on how many. A row that
--   reached the limit is 'failed' and waits for an administrator to try it
--   again. Uploads are found again by appProperties on the Drive files
--   (the envelope's id and the file's SHA-256), so a retry never makes a
--   second copy.

create table if not exists public.google_drive_tokens (
  user_id text primary key references public."user"(id) on delete cascade,
  google_subject text not null,
  google_email text not null,
  refresh_token text not null,
  scope text not null,
  created_at bigint not null,
  updated_at bigint not null
);

create table if not exists public.drive_exports (
  envelope_id text primary key references public.envelopes(id) on delete cascade,
  drive_id text not null,
  status text not null default 'pending'
    check (status in ('pending', 'exported', 'failed')),
  attempts integer not null default 0,
  next_attempt_at bigint not null,
  locked_until bigint,
  last_error text,
  folder_id text,
  signed_pdf_file_id text,
  certificate_file_id text,
  label_status text
    check (label_status is null or label_status in ('applied', 'failed', 'skipped')),
  label_error text,
  created_at bigint not null,
  updated_at bigint not null,
  exported_at bigint
);

-- What the retry job asks for: rows still to send, soonest first.
create index if not exists drive_exports_due_idx
  on public.drive_exports (next_attempt_at)
  where status = 'pending';

create index if not exists drive_exports_created_idx
  on public.drive_exports (created_at desc);
