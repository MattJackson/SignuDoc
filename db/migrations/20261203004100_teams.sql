-- Teams: groups of accounts who can see each other's envelopes.
--
-- An administrator makes a team and adds people to it. A member can open,
-- read the audit trail of, and download the finished files of an envelope
-- that someone else on one of their teams sent. Only the sender changes it.
-- Drafts stay the sender's own. See src/lib/envelope-access.ts.
--
-- * teams.google_group_email: the address of a Google Group the team is
--   meant to follow. Nothing reads it yet; it is kept so that a later sync
--   of the members from that group has somewhere to look.
-- * team_members: who is on which team. An account that is deleted leaves
--   its teams with it.

create table if not exists public.teams (
  id text primary key,
  name text not null check (length(btrim(name)) between 1 and 80),
  google_group_email text
    check (
      google_group_email is null
      or (
        length(google_group_email) <= 254
        and google_group_email ~ '^[^@[:space:]]+@[^@[:space:]]+$'
      )
    ),
  created_at bigint not null,
  updated_at bigint not null
);

create unique index if not exists teams_name_unique
  on public.teams (lower(name));

create unique index if not exists teams_google_group_email_unique
  on public.teams (lower(google_group_email))
  where google_group_email is not null;

create table if not exists public.team_members (
  team_id text not null references public.teams(id) on delete cascade,
  user_id text not null references public."user"(id) on delete cascade,
  added_at bigint not null,
  primary key (team_id, user_id)
);

-- From a person to their teams, as every envelope read asks.
create index if not exists team_members_user_idx
  on public.team_members (user_id, team_id);
