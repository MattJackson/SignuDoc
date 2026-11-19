import type { DbExecutor } from "../db/connection.ts";
import { isMissingSchemaError } from "../settings.ts";

// What the notifications job notices on its own, as opposed to what the
// audit trail records: an envelope whose deadline is a few days away, an
// envelope nobody has done anything with for a number of days, and a
// backup that failed. Each is queued as an event like any other, under a
// key that makes it happen once:
//
// * envelope_expiring_soon:<envelope>:<deadline>: once per deadline, so a
//   deadline that is moved and comes close again is announced again.
// * envelope_stuck:<envelope>: once per envelope.
// * backup_failed:<run>: once per failed backup run.
//
// "Activity" is anything in the envelope's audit trail except the emails
// and reminders the app itself sent.

const DAY = 24 * 60 * 60;
/** A backup older than this is not announced any more. */
const BACKUP_LOOKBACK_SECONDS = 7 * DAY;
/**
 * Only envelopes sent within this long are looked at for "no activity", so
 * turning notifications on does not announce every forgotten envelope.
 */
const STUCK_LOOKBACK_SECONDS = 90 * DAY;

export type ConditionSummary = {
  backupFailed: number;
  expiringSoon: number;
  stuck: number;
};

export async function queueConditionEvents(
  database: DbExecutor,
  {
    expiringDays,
    now,
    stuckDays,
  }: { expiringDays: number; now: number; stuckDays: number },
): Promise<ConditionSummary> {
  const summary: ConditionSummary = {
    backupFailed: 0,
    expiringSoon: 0,
    stuck: 0,
  };

  if (expiringDays > 0) {
    const result = await database.query(
      `
        INSERT INTO notification_events (
          id, dedupe_key, source, event, envelope_id, payload, created_at
        )
        SELECT
          gen_random_uuid()::text,
          'envelope_expiring_soon:' || e.id || ':' || e.expires_at::text,
          'job',
          'envelope_expiring_soon',
          e.id,
          jsonb_build_object('expiresAt', e.expires_at),
          $1::bigint
        FROM envelopes e
        WHERE e.status = 'sent'
          AND e.expires_at IS NOT NULL
          AND e.expires_at > $1::bigint
          AND e.expires_at <= $2::bigint
          -- Not for an envelope sent with a deadline that close already.
          AND e.sent_at IS NOT NULL
          AND e.sent_at <= $3::bigint
        ON CONFLICT (dedupe_key) DO NOTHING
      `,
      [now, now + expiringDays * DAY, now - DAY],
    );

    summary.expiringSoon = result.rowCount ?? 0;
  }

  if (stuckDays > 0) {
    const since = now - stuckDays * DAY;
    const result = await database.query(
      `
        INSERT INTO notification_events (
          id, dedupe_key, source, event, envelope_id, payload, created_at
        )
        SELECT
          gen_random_uuid()::text,
          'envelope_stuck:' || e.id,
          'job',
          'envelope_stuck',
          e.id,
          jsonb_build_object('idleDays', $3::int),
          $1::bigint
        FROM envelopes e
        WHERE e.status = 'sent'
          AND e.sent_at IS NOT NULL
          AND e.sent_at <= $2::bigint
          AND e.sent_at >= $4::bigint
          AND NOT EXISTS (
            SELECT 1 FROM audit_events a
            WHERE a.envelope_id = e.id
              AND a.created_at > $2::bigint
              AND a.event NOT IN ('email_sent', 'reminded_auto', 'reminded_manual')
          )
        ON CONFLICT (dedupe_key) DO NOTHING
      `,
      [now, since, stuckDays, now - STUCK_LOOKBACK_SECONDS],
    );

    summary.stuck = result.rowCount ?? 0;
  }

  try {
    const result = await database.query(
      `
        INSERT INTO notification_events (
          id, dedupe_key, source, event, envelope_id, payload, created_at
        )
        SELECT
          gen_random_uuid()::text,
          'backup_failed:' || r.id,
          'job',
          'backup_failed',
          NULL,
          jsonb_build_object('status', r.status),
          $1::bigint
        FROM backup_runs r
        WHERE r.status IN ('failed', 'partial')
          AND r.finished_at IS NOT NULL
          AND r.finished_at >= $2::bigint
        ON CONFLICT (dedupe_key) DO NOTHING
      `,
      [now, now - BACKUP_LOOKBACK_SECONDS],
    );

    summary.backupFailed = result.rowCount ?? 0;
  } catch (error) {
    // An install without the backup tables has no backups to announce.
    if (!isMissingSchemaError(error)) {
      throw error;
    }
  }

  return summary;
}
