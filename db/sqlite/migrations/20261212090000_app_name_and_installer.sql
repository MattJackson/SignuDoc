-- SQLite version of db/migrations/20261212090000_app_name_and_installer.sql.

alter table app_settings add column product_name text
  constraint app_settings_product_name_check
  check (product_name is null or length(product_name) between 1 and 60);

alter table app_settings add column installer_user_id text;
