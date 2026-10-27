-- =============================================================================
-- Operator-funded referral rewards (part 2 of 2)
--
-- * Funding. The operator sends USDT to the group wallet. Like any unattributed
--   receipt it lands in suspense; the administrator then allocates it to the
--   referral reward fund (allocation kind 'referral_fund'):
--     D suspense_deposits / C referral_reward_fund
--   So the fund only ever holds money the wallet actually received, and the
--   treasury reconciliation is unaffected.
-- * Rewards. When a referral qualifies (referred member approved and has a
--   credited deposit) the worker records one pending reward for the sponsor, at
--   the amount in the current 'referral' policy. One reward per referred member,
--   ever. An administrator approves or rejects it; the worker then posts
--     D referral_reward_fund / C user_cash (sponsor)
--   Pending and approved rewards are not on the ledger, so they cannot be
--   withdrawn. The fund may never go negative, so rewards can't exceed funding.
-- =============================================================================

-- The fund belongs to the operator, but like customer accounts it may never go
-- negative: that is what caps rewards at the amount actually funded.
create or replace function ledger.is_customer_purpose(p public.account_purpose) returns boolean
language sql immutable as $$
  select p in ('user_cash', 'user_reserved', 'user_pending_subscription', 'pool_investor_equity', 'suspense_deposits', 'referral_reward_fund')
$$;

-- Funding allocations have no member lines.
alter table public.allocations drop constraint allocations_kind_check;
alter table public.allocations add constraint allocations_kind_check check (kind in ('assignment', 'distribution', 'referral_fund'));

create table public.referral_rewards (
  id                 uuid primary key default gen_random_uuid(),
  -- One reward per referred member, ever (a rejection is final too).
  referred_user_id   uuid not null unique references auth.users (id) on delete restrict,
  sponsor_user_id    uuid not null references auth.users (id) on delete restrict,
  token_id           smallint not null references public.supported_tokens (id),
  amount_base        numeric(78,0) not null check (amount_base > 0),
  policy_version_id  bigint not null references public.policy_versions (id),
  qualified_at       timestamptz not null,
  created_at         timestamptz not null default now(),
  status             text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'posted')),
  reviewed_by        uuid references auth.users (id),
  reviewed_at        timestamptz,
  review_note        text,
  entry_id           bigint unique references public.journal_entries (id),
  posted_at          timestamptz,
  error              text,
  constraint no_self_reward check (referred_user_id <> sponsor_user_id),
  constraint reviewed_fields check ((status = 'pending') = (reviewed_by is null and reviewed_at is null)),
  constraint review_note_required check (status = 'pending' or char_length(btrim(coalesce(review_note, ''))) >= 10),
  constraint posted_has_entry check ((status = 'posted') = (entry_id is not null and posted_at is not null))
);
create index referral_rewards_sponsor_idx on public.referral_rewards (sponsor_user_id, created_at desc);
create index referral_rewards_open_idx on public.referral_rewards (created_at) where status in ('pending', 'approved');

-- Amounts, parties and policy are fixed at creation. The web role may only
-- review a pending reward; posting is the worker's.
create or replace function private.referral_rewards_guard() returns trigger
language plpgsql as $$
begin
  if new.referred_user_id <> old.referred_user_id or new.sponsor_user_id <> old.sponsor_user_id or new.token_id <> old.token_id
     or new.amount_base <> old.amount_base or new.policy_version_id <> old.policy_version_id or new.qualified_at <> old.qualified_at then
    raise exception 'referral rewards are immutable apart from their status' using errcode = 'P0005';
  end if;
  if old.status in ('rejected', 'posted') then
    raise exception 'referral reward % is already %', old.id, old.status using errcode = 'P0005';
  end if;
  if pg_has_role(session_user, 'app_web', 'member') and not pg_has_role(session_user, 'app_worker', 'member')
     and not (old.status = 'pending' and new.status in ('approved', 'rejected')) then
    raise exception 'only a pending referral reward can be reviewed' using errcode = 'P0005';
  end if;
  return new;
end $$;
create trigger referral_rewards_guard before update on public.referral_rewards
  for each row execute function private.referral_rewards_guard();
create trigger referral_rewards_no_delete before delete on public.referral_rewards
  for each row execute function private.forbid_mutation();

alter table public.referral_rewards enable row level security;
revoke all on public.referral_rewards from anon, authenticated;
create policy backend_all on public.referral_rewards to app_web, app_worker using (true) with check (true);
-- Members may read rewards they earned (defense in depth; the app reads via app_web).
grant select on public.referral_rewards to authenticated;
create policy own_rows on public.referral_rewards for select to authenticated using (sponsor_user_id = (select auth.uid()));

grant select on public.referral_rewards to app_web, app_worker;
grant update (status, reviewed_by, reviewed_at, review_note) on public.referral_rewards to app_web;
grant insert (referred_user_id, sponsor_user_id, token_id, amount_base, policy_version_id, qualified_at) on public.referral_rewards to app_worker;
grant update (status, entry_id, posted_at, error) on public.referral_rewards to app_worker;

revoke execute on function private.referral_rewards_guard() from public, anon, authenticated;
grant execute on function private.referral_rewards_guard() to app_web, app_worker;
