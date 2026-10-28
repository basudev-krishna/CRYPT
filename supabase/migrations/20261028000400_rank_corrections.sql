-- =============================================================================
-- Rank corrections
--
-- rank_achievements stays immutable: it records what the worker measured. An
-- administrator fixes a wrong rank (a glitch, mis-recorded earnings, a manual
-- arrangement) by appending a correction: 'revoke' takes a held rank away,
-- 'grant' gives one. The latest correction per member and rank wins, so a
-- mistaken correction is undone with the opposite one. Nothing is deleted.
--
-- A corrected rank is never re-evaluated by the worker: a revoked rank is not
-- reached again automatically, and a granted rank creates no rank reward (the
-- administrator awards income explicitly if one is owed).
-- =============================================================================

create table public.rank_corrections (
  id          bigserial primary key,
  user_id     uuid not null references auth.users (id) on delete restrict,
  rank_code   text not null check (rank_code ~ '^[A-Za-z0-9]{1,12}$'),
  action      text not null check (action in ('revoke', 'grant')),
  reason      text not null check (char_length(btrim(reason)) >= 10),
  created_by  uuid not null references auth.users (id) on delete restrict,
  created_at  timestamptz not null default now()
);
create index rank_corrections_user_idx on public.rank_corrections (user_id, rank_code, id desc);
create trigger rank_corrections_immutable before update or delete on public.rank_corrections
  for each row execute function private.forbid_mutation();

-- Effective ranks: measured ones not revoked since, plus granted ones.
create view public.member_ranks as
with latest as (
  select distinct on (user_id, rank_code) user_id, rank_code, action, created_at
    from public.rank_corrections
   order by user_id, rank_code, id desc
)
select a.user_id, a.rank_code, a.achieved_at, 'achieved'::text as source,
       a.left_volume, a.right_volume, a.self_volume
  from public.rank_achievements a
  left join latest l on l.user_id = a.user_id and l.rank_code = a.rank_code
 where l.action is null or l.action = 'grant'
union all
select l.user_id, l.rank_code, l.created_at as achieved_at, 'granted'::text as source,
       0::numeric(78,0), 0::numeric(78,0), 0::numeric(78,0)
  from latest l
 where l.action = 'grant'
   and not exists (select 1 from public.rank_achievements a where a.user_id = l.user_id and a.rank_code = l.rank_code);

alter table public.rank_corrections enable row level security;
revoke all on public.rank_corrections from anon, authenticated;
create policy backend_all on public.rank_corrections to app_web, app_worker using (true) with check (true);
grant select on public.rank_corrections to app_web, app_worker;
grant insert (user_id, rank_code, action, reason, created_by) on public.rank_corrections to app_web;
grant usage on sequence public.rank_corrections_id_seq to app_web;

revoke all on public.member_ranks from public, anon, authenticated;
grant select on public.member_ranks to app_web, app_worker;
