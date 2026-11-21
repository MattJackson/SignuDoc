-- SQLite version of db/migrations/20261119130000_consent_disclosure.sql:
-- the administrator's own consent disclosure text (char_length is length()
-- here).

alter table app_settings add column consent_disclosure text
  check (
    consent_disclosure is null
    or length(consent_disclosure) between 1 and 6000
  );
