-- Offboarding from the Google Workspace directory (directory-sync.ts).
--
-- An internal job asks the directory about each account in the
-- organization's Workspace domains. When the directory says someone is
-- suspended, archived or gone, their sign-in is blocked here too, and their
-- open envelopes and drafts are handed to their manager or an
-- administrator.
--
-- * user.directory_blocked_at: when the directory's answer blocked the
--   account's sign-in, with password and with single sign-on alike. Null
--   for an account that may sign in. Cleared when the directory says the
--   account is active again.
-- * user.directory_blocked_reason: what the directory said, one of
--   'directory_suspended', 'directory_archived', 'directory_deleted'.
-- * user.directory_checked_at: when the job last asked about the account,
--   so that each run starts with the accounts asked about longest ago and a
--   large organization is gone through over several runs.
--
-- A copy of the app from before this migration ignores the block and lets a
-- blocked account sign in again. Roll back past it only after the people it
-- blocked have been dealt with another way.

alter table public."user"
  add column if not exists directory_blocked_at bigint;

alter table public."user"
  add column if not exists directory_blocked_reason text;

alter table public."user"
  add column if not exists directory_checked_at bigint;

alter table public."user"
  drop constraint if exists user_directory_blocked_reason_check;

alter table public."user"
  add constraint user_directory_blocked_reason_check
    check (
      directory_blocked_reason is null
      or directory_blocked_reason in (
        'directory_suspended',
        'directory_archived',
        'directory_deleted'
      )
    );
