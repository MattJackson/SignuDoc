// Tables a trigger writes to when another table gets a row: an audit event
// queues a notification event (migration 20261209090000_notifications).
// A restore puts these first among the tables that become ready together,
// so the backup's own rows are there before the trigger runs, and the
// trigger's ON CONFLICT DO NOTHING keeps it from adding a second copy.
const TRIGGER_FILLED_TABLES = new Set(["notification_events"]);

/** The same tables, trigger-filled ones first, otherwise in order. */
export function triggerFilledTablesFirst(tables: string[]): string[] {
  return [
    ...tables.filter((name) => TRIGGER_FILLED_TABLES.has(name)),
    ...tables.filter((name) => !TRIGGER_FILLED_TABLES.has(name)),
  ];
}
