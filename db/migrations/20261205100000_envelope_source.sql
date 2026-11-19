-- Where a draft's document came from, when it did not come from an upload
-- in the app: a file in Google Drive or an attachment in Gmail, sent for
-- signature from the Google Workspace add-on.
--
-- * source_kind: 'drive' or 'gmail'. Null for an upload, and for every
--   envelope made before this migration.
-- * source_ref: what the document was in that place. For Drive, the file's
--   id, so the add-on can list the envelopes made from a selected file. For
--   Gmail, the message id and the attachment's part id.
--
-- Nothing else reads these; an envelope copied to a new draft does not
-- carry them over.

alter table public.envelopes
  add column if not exists source_kind text;

alter table public.envelopes
  add column if not exists source_ref text;

alter table public.envelopes
  drop constraint if exists envelopes_source_kind_check;

alter table public.envelopes
  add constraint envelopes_source_kind_check
    check (
      source_kind is null
      or source_kind in ('drive', 'gmail', 'upload')
    );

alter table public.envelopes
  drop constraint if exists envelopes_source_ref_length;

alter table public.envelopes
  add constraint envelopes_source_ref_length
    check (source_ref is null or length(source_ref) <= 512);

-- From a Drive file to the envelopes made from it.
create index if not exists envelopes_source_ref_idx
  on public.envelopes (source_kind, source_ref)
  where source_ref is not null;
