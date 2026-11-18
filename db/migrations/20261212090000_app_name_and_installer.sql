-- What the install calls itself, and who installed it.
--
-- * app_settings.product_name: the app's name, asked for first in
--   onboarding (such as "BusbarSigner"). Shown in the header, emails and
--   every name suggested for Google and Slack. Null falls back to the
--   organization's name.
-- * app_settings.installer_user_id: the account first-run setup made or
--   promoted. It cannot be closed from Settings.

alter table public.app_settings
  add column if not exists product_name text
    check (product_name is null or char_length(product_name) between 1 and 60),
  add column if not exists installer_user_id text;
