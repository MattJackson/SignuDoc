-- Where a draft's document came from, when it was sent for signature from
-- a workspace add-in (src/lib/workspace/add-in-envelopes.ts) rather than
-- uploaded in the app: an attachment of an email, or a file.
--
-- * source_provider: the workspace provider the add-in belongs to, such as
--   'google'.
-- * source_kind: 'mail' for an email's attachment, 'file' for a file.
-- * source_ref: what the document was there, in the provider's terms. For
--   a file, its id, so the add-in can list the envelopes made from the file
--   that is selected; for an attachment, the message and the part.
--
-- All three are null for an upload, and for every envelope made before
-- this migration. Nothing else reads them, and a draft copied from an
-- envelope does not carry them over.

alter table public.envelopes
  add column if not exists source_provider text;

alter table public.envelopes
  add column if not exists source_kind text;

alter table public.envelopes
  add column if not exists source_ref text;

alter table public.envelopes
  drop constraint if exists envelopes_source_kind_check;

alter table public.envelopes
  add constraint envelopes_source_kind_check
    check (source_kind is null or source_kind in ('file', 'mail'));

alter table public.envelopes
  drop constraint if exists envelopes_source_ref_length;

alter table public.envelopes
  add constraint envelopes_source_ref_length
    check (source_ref is null or length(source_ref) <= 512);

-- From a selected file to the envelopes made from it.
create index if not exists envelopes_source_ref_idx
  on public.envelopes (source_provider, source_kind, source_ref)
  where source_ref is not null;
