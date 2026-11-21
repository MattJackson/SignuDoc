-- SQLite version of
-- db/migrations/20261118120000_bulk_send_row_reason_cleared_with_envelope.sql:
-- clear a send-to-many row's reason as its envelope is deleted, before the
-- foreign key sets the row's envelope_id to null. The Postgres function and
-- trigger become one BEFORE DELETE trigger.

drop trigger if exists envelopes_clear_bulk_send_row_reason;

create trigger envelopes_clear_bulk_send_row_reason
  before delete on envelopes
  for each row
begin
  update bulk_send_batch_rows
  set reason = null
  where envelope_id = old.id and reason is not null;
end;
