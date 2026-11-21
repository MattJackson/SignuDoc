-- Notification threads: one message per envelope per place. See
-- docs/notifications.md and src/lib/notifications/outbox.ts.
--
-- * In a channel, the first post about an envelope starts a thread. Later
--   events reply in that thread, and the first post is edited to show
--   where the envelope stands now.
-- * In a person's direct messages, progress (sent, opened, signed,
--   approved, voided) edits one message per envelope; outcomes that need
--   attention post a new one.
--
-- A row remembers that message (the chat tool's conversation id and the
-- message's own id, Slack's "ts") for one envelope in one place: the same
-- place a delivery names (channel, target_kind, target). Before a delivery
-- posts or edits that message it takes the row's short lease, in a single
-- statement, so two runs never both start a thread for the same envelope.
-- parent_event_at is when the event the message shows happened, so a late
-- retry of an older event never puts back an older headline.

create table if not exists public.notification_threads (
  envelope_id text not null
    references public.envelopes(id) on delete cascade,
  channel text not null,
  target_kind text not null check (target_kind in ('user', 'channel')),
  target text not null,
  conversation text check (length(conversation) <= 100),
  message_ts text check (length(message_ts) <= 100),
  parent_event_at bigint,
  -- The delivery holding the lease, and until when.
  lease_owner text,
  lease_until bigint,
  created_at bigint not null,
  updated_at bigint not null,
  primary key (envelope_id, channel, target_kind, target)
);

create index if not exists notification_threads_updated_idx
  on public.notification_threads (updated_at);

-- Finding a newer delivery for the same envelope (burst collapse).
create index if not exists notification_events_envelope_idx
  on public.notification_events (envelope_id, created_at)
  where envelope_id is not null;
