-- SQLite version of db/migrations/20261118110000_webhooks.sql: webhook
-- endpoints and their deliveries. See that file for what each column is.
-- events is text[] (a JSON array of text here, as in the baseline's
-- allowed_email_domains); payload is text on both backends on purpose.

create table if not exists webhook_endpoints (
  id text not null primary key,
  url text not null check (length(url) between 1 and 2048),
  description text not null default '' check (length(description) <= 200),
  secret_encrypted text not null,
  previous_secret_encrypted text,
  previous_secret_expires_at bigint,
  events text[] not null,
  enabled boolean not null default 1,
  created_by text references "user" (id) on delete set null,
  created_at bigint not null,
  updated_at bigint not null
);

create table if not exists webhook_deliveries (
  id text not null primary key,
  endpoint_id text not null references webhook_endpoints (id) on delete cascade,
  event_type text not null,
  envelope_id text,
  audit_event_id text,
  signer_id text,
  payload text,
  status text not null default 'pending'
    check (status in ('pending', 'delivered', 'failed')),
  attempts integer not null default 0,
  next_attempt_at bigint,
  locked_until bigint,
  last_status_code integer,
  last_error text,
  created_at bigint not null,
  delivered_at bigint,
  updated_at bigint not null
);

create index if not exists webhook_deliveries_due_idx
  on webhook_deliveries (next_attempt_at)
  where status = 'pending';

create index if not exists webhook_deliveries_endpoint_idx
  on webhook_deliveries (endpoint_id, created_at desc);

create index if not exists webhook_deliveries_created_idx
  on webhook_deliveries (created_at desc, id desc);
