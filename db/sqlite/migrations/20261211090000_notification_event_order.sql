-- SQLite version of db/migrations/20261211090000_notification_event_order.sql.
-- SQLite has no serial column, so a trigger gives each new event the next
-- number. There is one writer, and writes are serialized, so the numbers
-- cannot repeat. Events already there are numbered by when they were added.

alter table notification_events add column seq bigint;

update notification_events set seq = rowid;

create index if not exists notification_events_seq_idx
  on notification_events (seq);

create trigger notification_events_assign_seq
  after insert on notification_events
  when new.seq is null
begin
  update notification_events
  set seq = (select coalesce(max(seq), 0) + 1 from notification_events)
  where rowid = new.rowid;
end;

alter table notification_threads add column parent_event_seq bigint;
