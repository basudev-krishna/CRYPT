-- =============================================================================
-- Rewards are claimed by the member before they are paid
-- =============================================================================
-- The group wants every reward shown to the member first and paid only after
-- the member claims it (transparency: nothing lands in a balance unseen).
-- Referral rewards and matching/rank rewards get a claimed_at timestamp:
--
--   recorded (pending) → member claims → administrator approves (either order)
--   → worker pays, only once both have happened.
--
-- The web role may set claimed_at once, on a pending or approved reward, and
-- change nothing else at the same time; a claim cannot be withdrawn. Reviews
-- by an administrator must leave claimed_at untouched. The application checks
-- that the claimant is the reward's owner.
-- =============================================================================
alter table public.referral_rewards add column claimed_at timestamptz;
alter table public.program_rewards add column claimed_at timestamptz;

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
  if old.claimed_at is not null and new.claimed_at is distinct from old.claimed_at then
    raise exception 'a claim cannot be changed or withdrawn' using errcode = 'P0005';
  end if;
  if pg_has_role(session_user, 'app_web', 'member') and not pg_has_role(session_user, 'app_worker', 'member')
     and not (
       -- an administrator's review
       (old.status = 'pending' and new.status in ('approved', 'rejected') and new.claimed_at is not distinct from old.claimed_at)
       -- the member's claim
       or (new.status = old.status and old.status in ('pending', 'approved') and old.claimed_at is null and new.claimed_at is not null)
     ) then
    raise exception 'only a pending referral reward can be reviewed, and an open one claimed' using errcode = 'P0005';
  end if;
  return new;
end $$;

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
  if old.claimed_at is not null and new.claimed_at is distinct from old.claimed_at then
    raise exception 'a claim cannot be changed or withdrawn' using errcode = 'P0005';
  end if;
  if pg_has_role(session_user, 'app_web', 'member') and not pg_has_role(session_user, 'app_worker', 'member')
     and not (
       (old.status = 'pending' and new.status in ('approved', 'rejected') and new.claimed_at is not distinct from old.claimed_at)
       or (new.status = old.status and old.status in ('pending', 'approved') and old.claimed_at is null and new.claimed_at is not null)
     ) then
    raise exception 'only a pending program reward can be reviewed, and an open one claimed' using errcode = 'P0005';
  end if;
  return new;
end $$;

grant update (claimed_at) on public.referral_rewards, public.program_rewards to app_web;
