-- SQLite version of db/migrations/20261210090000_notification_threads.sql:
-- one message per envelope per place, with the lease that keeps two runs
-- from both starting a thread. See that file for what each column is.

create table if not exists notification_threads (
  envelope_id text not null
    references envelopes (id) on delete cascade,
  channel text not null,
  target_kind text not null check (target_kind in ('user', 'channel')),
  target text not null,
  conversation text check (length(conversation) <= 100),
  message_ts text check (length(message_ts) <= 100),
  parent_event_at bigint,
  lease_owner text,
  lease_until bigint,
  created_at bigint not null,
  updated_at bigint not null,
  primary key (envelope_id, channel, target_kind, target)
);

create index if not exists notification_threads_updated_idx
  on notification_threads (updated_at);

create index if not exists notification_events_envelope_idx
  on notification_events (envelope_id, created_at)
  where envelope_id is not null;
