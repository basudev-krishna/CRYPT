-- =============================================================================
-- Team position at sign-up, matching bonus and rank rewards (part 2 of 2)
--
-- * Team position. A member who signs up with a referral id chooses the left or
--   right team. The auth trigger places them in the same transaction that
--   creates the account, under the sponsor on the chosen side. The current
--   'rewards_program' policy decides what happens when that spot is taken:
--     direct: sign-up is refused, so the member can choose the other side;
--     outer:  the member goes to the first free spot down that side's outer
--             edge (the side is never switched).
--   Candidate parents are locked while the spot is looked up, so two sign-ups
--   cannot take the same position; the one_child_per_side constraint is the
--   last line of defence. Only an administrator can move a member afterwards.
--
-- * Reward base. Matching bonuses and rank volume are measured only in
--   operator-funded earnings: ledger entries that move money between the
--   referral reward fund and a member's cash (referral rewards, administrator
--   bonuses for work, and their reversals). Deposits, allocations and
--   withdrawals never touch the fund, so they can never count. Matching and
--   rank rewards themselves are excluded, so rewards never feed rewards.
--
-- * Rewards. The worker records matching rewards (one per source entry and
--   level) and rank rewards (one per member and rank). An administrator
--   approves each one; approval checks the fund can cover it on top of
--   everything already approved. The worker then posts
--     D referral_reward_fund / C user_cash (beneficiary)
--   The fund may never go negative, so rewards cannot exceed operator funding.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Reward base: operator-funded earnings per member
-- -----------------------------------------------------------------------------
create view public.reward_base_earnings as
select e.id as entry_id,
       a.user_id,
       l.token_id,
       (case when l.direction = 'C' then l.amount else -l.amount end)::numeric(78,0) as amount_base,
       -- 18-decimal fixed point, so amounts in different stablecoins add up.
       ((case when l.direction = 'C' then l.amount else -l.amount end) * (10::numeric ^ (18 - t.decimals)))::numeric(78,0) as amount_fixed,
       e.event_type,
       e.posted_at
  from public.journal_entries e
  join public.journal_lines l on l.entry_id = e.id
  join public.ledger_accounts a on a.id = l.account_id and a.purpose = 'user_cash'
  join public.supported_tokens t on t.id = l.token_id
 where exists (select 1 from public.journal_lines f join public.ledger_accounts fa on fa.id = f.account_id
                where f.entry_id = e.id and fa.purpose = 'referral_reward_fund')
   and e.event_type <> 'program_reward'
   and not (e.event_type = 'reversal'
            and exists (select 1 from public.journal_entries o where o.id = e.reverses_entry_id and o.event_type = 'program_reward'));

-- -----------------------------------------------------------------------------
-- Team position at sign-up
-- -----------------------------------------------------------------------------
create or replace function private.place_new_member(p_user uuid, p_sponsor uuid, p_side text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_mode   text;
  v_cursor uuid := p_sponsor;
  v_child  uuid;
  v_steps  int := 0;
begin
  if p_side not in ('left', 'right') then
    raise exception 'team position must be left or right' using errcode = 'P0005';
  end if;
  select params ->> 'placement_mode' into v_mode from public.policy_versions
   where kind = 'rewards_program' and effective_from <= now() order by effective_from desc, version desc limit 1;
  v_mode := coalesce(v_mode, 'outer');
  loop
    -- Lock the candidate parent, then look: a concurrent sign-up for the same
    -- spot waits here and sees the committed child when it continues.
    perform 1 from public.user_profiles where user_id = v_cursor for update;
    select user_id into v_child from public.binary_placements where parent_user_id = v_cursor and side = p_side;
    exit when v_child is null;
    if v_mode = 'direct' then
      raise exception 'team position taken: the % side under this sponsor is already taken', p_side using errcode = 'P0005';
    end if;
    v_cursor := v_child;
    v_steps := v_steps + 1;
    if v_steps > 10000 then
      raise exception 'team tree too deep' using errcode = 'P0005';
    end if;
  end loop;
  insert into public.binary_placements (user_id, parent_user_id, side, placed_by) values (p_user, v_cursor, p_side, p_user);
  insert into public.placement_history (user_id, old_parent_id, old_side, new_parent_id, new_side, reason, changed_by)
  values (p_user, null, null, v_cursor, p_side, 'Chosen by the member at sign-up', p_user);
  return v_cursor;
end $$;

create or replace function private.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_meta     jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_inv      record;
  v_sponsor  uuid;
  v_referral text := upper(nullif(btrim(v_meta ->> 'referral_code'), ''));
  v_side     text := lower(nullif(btrim(v_meta ->> 'team_side'), ''));
begin
  select id, sponsor_user_id into v_inv from public.member_invitations where accepted_user_id = new.id;
  v_sponsor := v_inv.sponsor_user_id;
  if v_sponsor is null and v_referral is not null then
    select user_id into v_sponsor from public.user_profiles where member_code = v_referral and account_status = 'active';
  end if;
  insert into public.user_profiles (user_id, email, sponsor_user_id, invitation_id, account_status, username, display_name, phone, country_code)
  values (new.id, coalesce(new.email, ''), v_sponsor, v_inv.id, 'active',
          lower(nullif(btrim(v_meta ->> 'username'), '')),
          left(nullif(btrim(v_meta ->> 'full_name'), ''), 60),
          nullif(btrim(v_meta ->> 'phone'), ''),
          upper(nullif(btrim(v_meta ->> 'country_code'), '')))
  on conflict (user_id) do nothing;
  -- Placed in the same transaction as the account: a refused position refuses the sign-up.
  if v_sponsor is not null and v_side is not null
     and not exists (select 1 from public.binary_placements where user_id = new.id) then
    perform private.place_new_member(new.id, v_sponsor, v_side);
  end if;
  return new;
end $$;

-- -----------------------------------------------------------------------------
-- Matching and rank rewards
-- -----------------------------------------------------------------------------
create table public.program_rewards (
  id                   uuid primary key default gen_random_uuid(),
  kind                 text not null check (kind in ('matching', 'rank')),
  beneficiary_user_id  uuid not null references auth.users (id) on delete restrict,
  token_id             smallint not null references public.supported_tokens (id),
  amount_base          numeric(78,0) not null check (amount_base > 0),
  policy_version_id    bigint not null references public.policy_versions (id),
  -- Matching: the operator-funded earning it matches, whose it was, the level and rate.
  source_entry_id      bigint references public.journal_entries (id),
  source_user_id       uuid references auth.users (id),
  level                smallint check (level between 1 and 10),
  rate_bps             integer check (rate_bps between 1 and 10000),
  base_amount          numeric(78,0) check (base_amount > 0),
  -- Rank: the rank reached.
  rank_code            text,
  created_at           timestamptz not null default now(),
  status               text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled', 'posted')),
  reviewed_by          uuid references auth.users (id),
  reviewed_at          timestamptz,
  review_note          text,
  entry_id             bigint unique references public.journal_entries (id),
  posted_at            timestamptz,
  error                text,
  constraint matching_fields check (kind <> 'matching' or (source_entry_id is not null and source_user_id is not null and level is not null
                                                           and rate_bps is not null and base_amount is not null and rank_code is null)),
  constraint rank_fields check (kind <> 'rank' or (rank_code is not null and source_entry_id is null and source_user_id is null and level is null)),
  constraint no_self_match check (source_user_id is distinct from beneficiary_user_id),
  constraint reviewed_fields check (status not in ('approved', 'rejected', 'posted') or (reviewed_by is not null and reviewed_at is not null)),
  constraint review_note_required check (status not in ('approved', 'rejected') or char_length(btrim(coalesce(review_note, ''))) >= 10),
  constraint posted_has_entry check ((status = 'posted') = (entry_id is not null and posted_at is not null))
);
-- No duplicate reward for the same earning and level, or the same member and rank.
create unique index program_rewards_matching_uq on public.program_rewards (source_entry_id, level) where kind = 'matching';
create unique index program_rewards_rank_uq on public.program_rewards (beneficiary_user_id, rank_code) where kind = 'rank';
create index program_rewards_beneficiary_idx on public.program_rewards (beneficiary_user_id, created_at desc);
create index program_rewards_open_idx on public.program_rewards (created_at) where status in ('pending', 'approved');

create or replace function private.program_rewards_guard() returns trigger
language plpgsql as $$
begin
  if new.kind <> old.kind or new.beneficiary_user_id <> old.beneficiary_user_id or new.token_id <> old.token_id
     or new.amount_base <> old.amount_base or new.policy_version_id <> old.policy_version_id
     or new.source_entry_id is distinct from old.source_entry_id or new.source_user_id is distinct from old.source_user_id
     or new.level is distinct from old.level or new.rate_bps is distinct from old.rate_bps
     or new.base_amount is distinct from old.base_amount or new.rank_code is distinct from old.rank_code then
    raise exception 'program rewards are immutable apart from their status' using errcode = 'P0005';
  end if;
  if old.status in ('rejected', 'cancelled', 'posted') then
    raise exception 'program reward % is already %', old.id, old.status using errcode = 'P0005';
  end if;
  if pg_has_role(session_user, 'app_web', 'member') and not pg_has_role(session_user, 'app_worker', 'member')
     and not (old.status = 'pending' and new.status in ('approved', 'rejected')) then
    raise exception 'only a pending program reward can be reviewed' using errcode = 'P0005';
  end if;
  return new;
end $$;
create trigger program_rewards_guard before update on public.program_rewards
  for each row execute function private.program_rewards_guard();
create trigger program_rewards_no_delete before delete on public.program_rewards
  for each row execute function private.forbid_mutation();

-- Each operator-funded earning is matched once, under the policy current then.
create table public.matching_sources (
  entry_id           bigint primary key references public.journal_entries (id),
  policy_version_id  bigint not null references public.policy_versions (id),
  rewards_created    integer not null check (rewards_created between 0 and 10),
  processed_at       timestamptz not null default now()
);
create trigger matching_sources_immutable before update or delete on public.matching_sources
  for each row execute function private.forbid_mutation();

-- Ranks are permanent once reached; the volumes at that moment are kept.
create table public.rank_achievements (
  user_id            uuid not null references auth.users (id) on delete restrict,
  rank_code          text not null,
  rank_order         smallint not null check (rank_order between 1 and 50),
  policy_version_id  bigint not null references public.policy_versions (id),
  left_volume        numeric(78,0) not null,
  right_volume       numeric(78,0) not null,
  self_volume        numeric(78,0) not null,
  achieved_at        timestamptz not null default now(),
  primary key (user_id, rank_code)
);
create trigger rank_achievements_immutable before update or delete on public.rank_achievements
  for each row execute function private.forbid_mutation();

-- -----------------------------------------------------------------------------
-- Access control
-- -----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['program_rewards', 'matching_sources', 'rank_achievements'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('create policy backend_all on public.%I to app_web, app_worker using (true) with check (true)', t);
    execute format('grant select on public.%I to app_web, app_worker', t);
  end loop;
end $$;

-- Members may read their own rewards and ranks (defense in depth; the app reads via app_web).
grant select on public.program_rewards, public.rank_achievements to authenticated;
create policy own_rows on public.program_rewards for select to authenticated using (beneficiary_user_id = (select auth.uid()));
create policy own_rows on public.rank_achievements for select to authenticated using (user_id = (select auth.uid()));

grant update (status, reviewed_by, reviewed_at, review_note) on public.program_rewards to app_web;
grant insert (kind, beneficiary_user_id, token_id, amount_base, policy_version_id, source_entry_id, source_user_id, level, rate_bps, base_amount, rank_code)
  on public.program_rewards to app_worker;
grant update (status, entry_id, posted_at, error) on public.program_rewards to app_worker;
grant insert on public.matching_sources, public.rank_achievements to app_worker;

revoke all on public.reward_base_earnings from public, anon, authenticated;
grant select on public.reward_base_earnings to app_web, app_worker;

revoke execute on function private.program_rewards_guard(), private.place_new_member(uuid, uuid, text) from public, anon, authenticated;
grant execute on function private.program_rewards_guard() to app_web, app_worker;
