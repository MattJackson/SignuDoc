-- Notification events get a sequence number, so two events in the same
-- second are told apart by the order they were queued in, not by their
-- random ids. A held "signed" message is skipped when a later event for the
-- same envelope exists, and a thread is only edited by an event newer than
-- the one it shows; both compare (created_at, seq). The column is filled by
-- its default, so the audit trigger and the job need no change.
-- notification_threads remembers the sequence of the event it shows.

alter table public.notification_events
  add column if not exists seq bigserial;

alter table public.notification_threads
  add column if not exists parent_event_seq bigint;
