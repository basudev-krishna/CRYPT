-- =============================================================================
-- Manual balance adjustments backed by an operator float (part 2 of 2)
--
-- In a close group, members sometimes pay the administrator personally (or are
-- paid back personally) while their balance lives on the platform. The
-- administrator reflects that on the platform without creating money:
--
--   float top-up (allocation 'operator_float'):  D suspense_deposits  C operator_float
--   credit a member (paid the admin personally):  D operator_float     C user_cash
--   debit a member (admin paid them personally):  D user_cash          C operator_float
--
-- The float is operator money actually received in the group wallet and may
-- never go negative, so every credited balance stays backed on chain and
-- reconciliation keeps passing. Adjustments are recorded by the web role and
-- posted by the worker; corrections are opposite adjustments (reversals).
-- =============================================================================

create or replace function ledger.is_customer_purpose(p public.account_purpose) returns boolean
language sql immutable as $$
  select p in ('user_cash', 'user_reserved', 'user_pending_subscription', 'pool_investor_equity', 'suspense_deposits',
               'referral_reward_fund', 'operator_float')
$$;

alter table public.allocations drop constraint allocations_kind_check;
alter table public.allocations add constraint allocations_kind_check
  check (kind in ('assignment', 'distribution', 'referral_fund', 'operator_float'));

create table public.manual_adjustments (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references auth.users (id) on delete restrict,
  token_id                smallint not null references public.supported_tokens (id),
  direction               text not null check (direction in ('credit', 'debit')),
  amount_base             numeric(78,0) not null check (amount_base > 0),
  reason                  text not null check (char_length(btrim(reason)) >= 10),
  reverses_adjustment_id  uuid unique references public.manual_adjustments (id),
  created_by              uuid not null references auth.users (id),
  created_at              timestamptz not null default now(),
  status                  text not null default 'pending' check (status in ('pending', 'posted', 'failed', 'cancelled')),
  entry_id                bigint unique references public.journal_entries (id),
  posted_at               timestamptz,
  error                   text,
  constraint posted_has_entry check ((status = 'posted') = (entry_id is not null and posted_at is not null))
);
create index manual_adjustments_user_idx on public.manual_adjustments (user_id, created_at desc);
create index manual_adjustments_pending_idx on public.manual_adjustments (created_at) where status = 'pending';

create or replace function private.manual_adjustments_guard() returns trigger
language plpgsql as $$
begin
  if new.user_id <> old.user_id or new.token_id <> old.token_id or new.direction <> old.direction or new.amount_base <> old.amount_base
     or new.reason <> old.reason or new.reverses_adjustment_id is distinct from old.reverses_adjustment_id or new.created_by <> old.created_by then
    raise exception 'manual adjustments are immutable apart from their status' using errcode = 'P0005';
  end if;
  if old.status <> 'pending' then
    raise exception 'manual adjustment % is already %', old.id, old.status using errcode = 'P0005';
  end if;
  if pg_has_role(session_user, 'app_web', 'member') and not pg_has_role(session_user, 'app_worker', 'member') and new.status <> 'cancelled' then
    raise exception 'only a pending adjustment can be cancelled' using errcode = 'P0005';
  end if;
  return new;
end $$;
create trigger manual_adjustments_guard before update on public.manual_adjustments
  for each row execute function private.manual_adjustments_guard();
create trigger manual_adjustments_no_delete before delete on public.manual_adjustments
  for each row execute function private.forbid_mutation();

alter table public.manual_adjustments enable row level security;
revoke all on public.manual_adjustments from anon, authenticated;
create policy backend_all on public.manual_adjustments to app_web, app_worker using (true) with check (true);
grant select on public.manual_adjustments to authenticated;
create policy own_rows on public.manual_adjustments for select to authenticated using (user_id = (select auth.uid()));

grant select on public.manual_adjustments to app_web, app_worker;
grant insert (user_id, token_id, direction, amount_base, reason, reverses_adjustment_id, created_by) on public.manual_adjustments to app_web;
grant update (status, error) on public.manual_adjustments to app_web; -- cancelling a pending adjustment
grant update (status, entry_id, posted_at, error) on public.manual_adjustments to app_worker;

revoke execute on function private.manual_adjustments_guard() from public, anon, authenticated;
grant execute on function private.manual_adjustments_guard() to app_web, app_worker;
