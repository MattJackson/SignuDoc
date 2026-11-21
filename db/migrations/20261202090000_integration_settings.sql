-- Settings for the services the app connects to (Resend, single sign-on,
-- the Google Workspace directory) and the first-run onboarding, one row
-- per setting. They are kept apart from app_settings so that adding one is
-- a new row, not a new column.
--
-- A value marked secret (an API key, a client secret) is stored encrypted
-- with a key derived from BETTER_AUTH_SECRET, the same way as the seal key,
-- and is never sent back to the browser. An environment variable that sets
-- the same thing always wins over what is stored here.

create table if not exists public.integration_settings (
  key text primary key,
  value text not null,
  secret boolean not null default false,
  updated_at bigint not null,
  updated_by text
);
