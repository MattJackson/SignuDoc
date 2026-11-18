-- Where the daily backup goes, as chosen by an administrator in Settings,
-- and what each backup run did. Environment variables (BACKUP_GCS_BUCKET,
-- BACKUP_BLOB_READ_WRITE_TOKEN, BACKUP_KEEP_DAYS) still win over this row.

create table if not exists public.backup_settings (
  -- One row for the install.
  id boolean primary key default true check (id),
  destination text not null default 'none'
    check (destination in ('none', 'gcs', 'blob')),
  gcs_bucket text,
  gcs_prefix text not null default '',
  -- A Blob store's read-write token, encrypted with a key derived from the
  -- auth secret, like the seal key.
  blob_token_encrypted text,
  keep_days integer not null default 30
    check (keep_days between 1 and 3650),
  -- Whether the daily run copies anything. "Run backup now" works either way.
  enabled boolean not null default true,
  updated_at bigint not null,
  updated_by text
);

create table if not exists public.backup_runs (
  id text primary key,
  started_at bigint not null,
  finished_at bigint,
  status text not null
    check (status in ('running', 'succeeded', 'partial', 'failed')),
  trigger text not null check (trigger in ('schedule', 'manual')),
  destination text not null,
  summary jsonb,
  -- What went wrong, in words safe to show an administrator: never a
  -- response body or a secret.
  error text
);

create index if not exists backup_runs_started_at_idx
  on public.backup_runs (started_at desc);
