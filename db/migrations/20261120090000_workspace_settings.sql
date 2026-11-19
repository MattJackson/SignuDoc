-- What an administrator chooses for the organization's workspace provider
-- (Google Workspace today): which provider, and which of its parts are on.
-- One row per setting (src/lib/workspace/settings.ts). Nothing secret is
-- kept here: keys and client secrets come from the environment.
--
-- With no rows, no provider is used and the app behaves as before.

create table if not exists public.workspace_settings (
  key text primary key,
  value text not null,
  updated_at bigint not null,
  -- The administrator who last changed it; the audit trail has the rest.
  updated_by text
);
