-- SQLite version of db/migrations/20261119090000_signing_steps.sql: nothing
-- to do. That Postgres file is byte for byte the fork's earlier
-- 20261203004000_signing_steps.sql, whose SQLite result (signers.signing_step
-- with its CHECKs, no idx_signers_single_notified, the 100-role limit on
-- templates) is already in baseline.sql.

select 1;
