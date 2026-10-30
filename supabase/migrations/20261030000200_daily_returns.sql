-- =============================================================================
-- Fixed daily returns (part 2 of 2): plans, subscriptions, accruals, revenue
--
-- A plan promises a fixed daily rate on principal (a contractual obligation of
-- the company, not trading profit). The worker accrues it per subscription and
-- UTC day, moves it to payable when due, and settles it into the member's cash
-- ONLY from a reserve funded by receipts recorded as business revenue:
--
--   subscribe:      D user_cash        C plan_principal
--   accrue (day):   D return_cost      C return_accrued
--   becomes due:    D return_accrued   C return_payable
--   revenue:        D suspense_deposits C return_reserve      (allocation 'business_revenue')
--   settle:         D return_payable   C user_cash
--                   D return_reserve   C return_cost
--   principal back: D plan_principal   C user_cash
--
-- return_cost therefore always equals accrued + payable (the unfunded part of
-- the promise); reconciliation checks it. See docs/daily-returns.md.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Ledger account rules for the new purposes
-- -----------------------------------------------------------------------------
create or replace function ledger.is_customer_purpose(p public.account_purpose) returns boolean
language sql immutable as $$
  select p in ('user_cash', 'user_reserved', 'user_pending_subscription', 'pool_investor_equity', 'suspense_deposits',
               'referral_reward_fund', 'operator_float',
               'plan_principal', 'return_accrued', 'return_payable', 'return_reserve')
$$;

create or replace function ledger.purpose_type(p public.account_purpose) returns public.account_type
language sql immutable as $$
  select case
    when p in ('treasury_hot', 'treasury_cold', 'pool_assets') then 'asset'::public.account_type
    when p = 'fee_revenue' then 'revenue'::public.account_type
    when p in ('network_fee_expense', 'return_cost') then 'expense'::public.account_type
    when p = 'owner_equity' then 'equity'::public.account_type
    else 'liability'::public.account_type
  end
$$;

alter table public.ledger_accounts drop constraint user_scoped;
alter table public.ledger_accounts add constraint user_scoped check (
  (purpose in ('user_cash', 'user_reserved', 'user_pending_subscription', 'plan_principal', 'return_accrued', 'return_payable')) = (user_id is not null)
);

-- -----------------------------------------------------------------------------
-- Pauses
-- -----------------------------------------------------------------------------
alter table public.system_controls drop constraint system_controls_key_check;
alter table public.system_controls add constraint system_controls_key_check
  check (key in ('withdrawals_paused', 'deposits_paused', 'allocations_paused', 'return_accruals_paused', 'return_settlements_paused'));
insert into public.system_controls (key, enabled) values ('return_accruals_paused', false), ('return_settlements_paused', false)
on conflict (key) do nothing;

-- -----------------------------------------------------------------------------
-- Business revenue: the only source of the return reserve
-- -----------------------------------------------------------------------------
alter table public.allocations drop constraint allocations_kind_check;
alter table public.allocations add constraint allocations_kind_check
  check (kind in ('assignment', 'distribution', 'referral_fund', 'operator_float', 'business_revenue'));

create table public.business_revenue_records (
  allocation_id       uuid primary key references public.allocations (id) on delete restrict,
  business_line       text not null check (char_length(btrim(business_line)) between 3 and 120),
  period_start        date not null,
  period_end          date not null,
  evidence_reference  text not null check (char_length(btrim(evidence_reference)) between 5 and 500),
  created_by          uuid not null references auth.users (id),
  created_at          timestamptz not null default now(),
  constraint period_order check (period_end >= period_start)
);
create trigger business_revenue_records_immutable before update or delete on public.business_revenue_records
  for each row execute function private.forbid_mutation();

-- -----------------------------------------------------------------------------
-- Plans: immutable terms, status draft -> active -> closed
-- -----------------------------------------------------------------------------
create table public.return_plans (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null check (char_length(btrim(name)) between 3 and 80),
  token_id             smallint not null references public.supported_tokens (id),
  daily_rate_ppm       integer not null check (daily_rate_ppm > 0 and daily_rate_ppm <= 100000),
  min_principal_base   numeric(78,0) not null check (min_principal_base > 0),
  term_days            integer check (term_days is null or term_days > 0),
  payable_after_days   integer not null check (payable_after_days between 0 and 3650),
  principal_lock_days  integer not null check (principal_lock_days between 0 and 3650),
  terms_reference      text not null check (char_length(btrim(terms_reference)) between 5 and 500),
  status               text not null default 'draft' check (status in ('draft', 'active', 'closed')),
  created_by           uuid not null references auth.users (id),
  created_at           timestamptz not null default now(),
  activated_by         uuid references auth.users (id),
  activated_at         timestamptz,
  activation_note      text,
  closed_by            uuid references auth.users (id),
  closed_at            timestamptz,
  close_note           text,
  -- Every day of the minimum principal must accrue at least one base unit.
  constraint nonzero_accrual check (min_principal_base * daily_rate_ppm >= 1000000),
  constraint active_was_activated check (status <> 'active' or (activated_by is not null and activated_at is not null)),
  constraint closed_has_time check (status <> 'closed' or (closed_by is not null and closed_at is not null))
);

create or replace function private.return_plans_guard() returns trigger
language plpgsql as $$
begin
  if new.name <> old.name or new.token_id <> old.token_id or new.daily_rate_ppm <> old.daily_rate_ppm
     or new.min_principal_base <> old.min_principal_base or new.term_days is distinct from old.term_days
     or new.payable_after_days <> old.payable_after_days or new.principal_lock_days <> old.principal_lock_days
     or new.terms_reference <> old.terms_reference or new.created_by <> old.created_by or new.created_at <> old.created_at then
    raise exception 'plan terms are immutable; create a new plan' using errcode = 'P0005';
  end if;
  if (old.status, new.status) not in (('draft', 'active'), ('draft', 'closed'), ('active', 'closed')) then
    raise exception 'plan cannot go from % to %', old.status, new.status using errcode = 'P0005';
  end if;
  if old.activated_at is not null and (new.activated_at is distinct from old.activated_at or new.activated_by is distinct from old.activated_by) then
    raise exception 'activation is recorded once' using errcode = 'P0005';
  end if;
  return new;
end $$;
create trigger return_plans_guard before update on public.return_plans
  for each row execute function private.return_plans_guard();
create trigger return_plans_no_delete before delete on public.return_plans
  for each row execute function private.forbid_mutation();

-- -----------------------------------------------------------------------------
-- Subscriptions: one fixed principal each; accrual dates are [start, end)
-- -----------------------------------------------------------------------------
create table public.plan_subscriptions (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users (id) on delete restrict,
  plan_id              uuid not null references public.return_plans (id),
  token_id             smallint not null references public.supported_tokens (id),
  principal_base       numeric(78,0) not null check (principal_base > 0),
  client_key           text not null check (client_key ~ '^[A-Za-z0-9_-]{16,100}$'),
  status               text not null default 'pending'
                       check (status in ('pending', 'active', 'redeem_requested', 'redeemed', 'failed', 'cancelled')),
  requested_at         timestamptz not null default now(),
  activated_at         timestamptz,
  open_entry_id        bigint unique references public.journal_entries (id),
  accrual_start_date   date,
  accrual_end_date     date,
  redeem_requested_at  timestamptz,
  redeemed_at          timestamptz,
  redeem_entry_id      bigint unique references public.journal_entries (id),
  error                text,
  unique (user_id, client_key),
  constraint opened_has_entry check (
    status in ('pending', 'failed', 'cancelled') or (open_entry_id is not null and activated_at is not null and accrual_start_date is not null)),
  constraint redeemed_has_entry check ((status = 'redeemed') = (redeem_entry_id is not null and redeemed_at is not null)),
  constraint redeem_has_time check (status not in ('redeem_requested', 'redeemed') or redeem_requested_at is not null),
  constraint end_after_start check (accrual_end_date is null or accrual_start_date is null or accrual_end_date >= accrual_start_date)
);
create index plan_subscriptions_user_idx on public.plan_subscriptions (user_id, requested_at desc);
create index plan_subscriptions_open_idx on public.plan_subscriptions (status) where status in ('pending', 'active', 'redeem_requested');

create or replace function private.plan_subscriptions_guard() returns trigger
language plpgsql as $$
declare
  v_web_only boolean := pg_has_role(session_user, 'app_web', 'member') and not pg_has_role(session_user, 'app_worker', 'member');
  v_lock integer;
begin
  if new.user_id <> old.user_id or new.plan_id <> old.plan_id or new.token_id <> old.token_id or new.principal_base <> old.principal_base
     or new.client_key <> old.client_key or new.requested_at <> old.requested_at then
    raise exception 'a subscription''s principal and plan are immutable' using errcode = 'P0005';
  end if;
  if new.status <> old.status and (old.status, new.status) not in (
       ('pending', 'active'), ('pending', 'failed'), ('pending', 'cancelled'), ('active', 'redeem_requested'), ('redeem_requested', 'redeemed')) then
    raise exception 'subscription cannot go from % to %', old.status, new.status using errcode = 'P0005';
  end if;
  if old.activated_at is not null and new.activated_at is distinct from old.activated_at
     or old.accrual_start_date is not null and new.accrual_start_date is distinct from old.accrual_start_date
     or old.redeem_requested_at is not null and new.redeem_requested_at is distinct from old.redeem_requested_at then
    raise exception 'subscription dates are recorded once' using errcode = 'P0005';
  end if;
  -- The accrual window may only shrink: no one can extend a promise after the fact.
  if old.accrual_end_date is not null and (new.accrual_end_date is null or new.accrual_end_date > old.accrual_end_date) then
    raise exception 'the accrual end date can only move earlier' using errcode = 'P0005';
  end if;
  if new.status = 'redeem_requested' and old.status = 'active' then
    select principal_lock_days into v_lock from public.return_plans where id = new.plan_id;
    if new.redeem_requested_at < now() - interval '5 minutes' or new.redeem_requested_at > now() + interval '5 minutes' then
      raise exception 'a redemption request is timestamped when it is made' using errcode = 'P0005';
    end if;
    if new.redeem_requested_at < old.activated_at + make_interval(days => v_lock) then
      raise exception 'principal is locked until %', old.activated_at + make_interval(days => v_lock) using errcode = 'P0005';
    end if;
  end if;
  if v_web_only and new.status = old.status then
    raise exception 'the web role may only cancel a pending subscription or request redemption' using errcode = 'P0005';
  end if;
  if v_web_only and (old.status, new.status) not in (('pending', 'cancelled'), ('active', 'redeem_requested')) then
    raise exception 'the web role may only cancel a pending subscription or request redemption' using errcode = 'P0005';
  end if;
  return new;
end $$;
create trigger plan_subscriptions_guard before update on public.plan_subscriptions
  for each row execute function private.plan_subscriptions_guard();
create trigger plan_subscriptions_no_delete before delete on public.plan_subscriptions
  for each row execute function private.forbid_mutation();

-- -----------------------------------------------------------------------------
-- Accruals: one row per subscription and UTC day, reproducible from its inputs
-- -----------------------------------------------------------------------------
create table public.return_accruals (
  id                bigint generated always as identity primary key,
  subscription_id   uuid not null references public.plan_subscriptions (id),
  user_id           uuid not null references auth.users (id) on delete restrict,
  token_id          smallint not null references public.supported_tokens (id),
  plan_id           uuid not null references public.return_plans (id),
  accrual_date      date not null,
  principal_base    numeric(78,0) not null check (principal_base > 0),
  daily_rate_ppm    integer not null check (daily_rate_ppm > 0),
  amount_base       numeric(78,0) not null check (amount_base > 0),
  payable_on        date not null,
  status            text not null default 'accrued' check (status in ('accrued', 'payable', 'settled')),
  accrual_entry_id  bigint not null unique references public.journal_entries (id),
  payable_entry_id  bigint unique references public.journal_entries (id),
  settle_entry_id   bigint unique references public.journal_entries (id),
  created_at        timestamptz not null default now(),
  payable_at        timestamptz,
  settled_at        timestamptz,
  unique (subscription_id, accrual_date),
  -- The formula, enforced: floor(principal x rate / 1 000 000).
  constraint amount_is_formula check (amount_base = div(principal_base * daily_rate_ppm, 1000000)),
  constraint payable_after_earned check (payable_on > accrual_date),
  constraint state_entries check (
    (status = 'accrued' and payable_entry_id is null and settle_entry_id is null)
    or (status = 'payable' and payable_entry_id is not null and payable_at is not null and settle_entry_id is null)
    or (status = 'settled' and payable_entry_id is not null and settle_entry_id is not null and settled_at is not null))
);
create index return_accruals_open_idx on public.return_accruals (status, payable_on, accrual_date, id) where status <> 'settled';
create index return_accruals_user_idx on public.return_accruals (user_id, accrual_date desc);

create or replace function private.return_accruals_guard() returns trigger
language plpgsql as $$
begin
  if new.subscription_id <> old.subscription_id or new.user_id <> old.user_id or new.token_id <> old.token_id or new.plan_id <> old.plan_id
     or new.accrual_date <> old.accrual_date or new.principal_base <> old.principal_base or new.daily_rate_ppm <> old.daily_rate_ppm
     or new.amount_base <> old.amount_base or new.payable_on <> old.payable_on or new.accrual_entry_id <> old.accrual_entry_id then
    raise exception 'accruals are immutable apart from their status' using errcode = 'P0005';
  end if;
  if (old.status, new.status) not in (('accrued', 'payable'), ('payable', 'settled')) then
    raise exception 'accrual cannot go from % to %', old.status, new.status using errcode = 'P0005';
  end if;
  return new;
end $$;
create trigger return_accruals_guard before update on public.return_accruals
  for each row execute function private.return_accruals_guard();
create trigger return_accruals_no_delete before delete on public.return_accruals
  for each row execute function private.forbid_mutation();

-- -----------------------------------------------------------------------------
-- Access: web records requests, the worker posts; members read their own rows
-- -----------------------------------------------------------------------------
alter table public.return_plans enable row level security;
alter table public.plan_subscriptions enable row level security;
alter table public.return_accruals enable row level security;
alter table public.business_revenue_records enable row level security;
revoke all on public.return_plans, public.plan_subscriptions, public.return_accruals, public.business_revenue_records from anon, authenticated;

create policy backend_all on public.return_plans to app_web, app_worker using (true) with check (true);
create policy backend_all on public.plan_subscriptions to app_web, app_worker using (true) with check (true);
create policy backend_all on public.return_accruals to app_web, app_worker using (true) with check (true);
create policy backend_all on public.business_revenue_records to app_web, app_worker using (true) with check (true);

grant select on public.return_plans, public.plan_subscriptions, public.return_accruals to authenticated;
create policy offered_plans on public.return_plans for select to authenticated using (status <> 'draft');
create policy own_rows on public.plan_subscriptions for select to authenticated using (user_id = (select auth.uid()));
create policy own_rows on public.return_accruals for select to authenticated using (user_id = (select auth.uid()));

grant select on public.return_plans, public.plan_subscriptions, public.return_accruals, public.business_revenue_records to app_web, app_worker;

grant insert (name, token_id, daily_rate_ppm, min_principal_base, term_days, payable_after_days, principal_lock_days, terms_reference, created_by)
  on public.return_plans to app_web;
grant update (status, activated_by, activated_at, activation_note, closed_by, closed_at, close_note) on public.return_plans to app_web;

grant insert (user_id, plan_id, token_id, principal_base, client_key) on public.plan_subscriptions to app_web;
grant update (status, redeem_requested_at, error) on public.plan_subscriptions to app_web;
grant update (status, activated_at, open_entry_id, accrual_start_date, accrual_end_date, redeemed_at, redeem_entry_id, error)
  on public.plan_subscriptions to app_worker;

grant insert (subscription_id, user_id, token_id, plan_id, accrual_date, principal_base, daily_rate_ppm, amount_base, payable_on, accrual_entry_id)
  on public.return_accruals to app_worker;
grant update (status, payable_entry_id, payable_at, settle_entry_id, settled_at) on public.return_accruals to app_worker;

grant insert (allocation_id, business_line, period_start, period_end, evidence_reference, created_by) on public.business_revenue_records to app_web;

revoke execute on function private.return_plans_guard(), private.plan_subscriptions_guard(), private.return_accruals_guard() from public, anon, authenticated;
grant execute on function private.return_plans_guard(), private.plan_subscriptions_guard(), private.return_accruals_guard() to app_web, app_worker;
