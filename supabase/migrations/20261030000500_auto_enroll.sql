-- =============================================================================
-- Fixed daily returns: automatic enrolment of member deposits
--
-- A plan created with auto_enroll puts every member deposit into it without
-- the member subscribing: existing deposits when the plan is activated, and
-- each new one as it is credited.
--
--   on-platform: each user_cash credit from a deposit (deposit_credit, or an
--     admin assignment/distribution of a group-wallet receipt) becomes a
--     subscription moving that cash into plan_principal;
--   offline: each off-platform contribution recorded for a linked member
--     becomes an offline subscription (principal stays off the ledger).
--
-- Each source is enrolled at most once (unique source columns). Accrual starts
-- the day after the money was received, but never before the plan was
-- activated, so no obligation is created for days before the plan existed.
-- =============================================================================

alter table public.return_plans add column auto_enroll boolean not null default false;
grant insert (auto_enroll) on public.return_plans to app_web;

create or replace function private.return_plans_auto_enroll_immutable() returns trigger
language plpgsql as $$
begin
  if new.auto_enroll <> old.auto_enroll then
    raise exception 'plan terms are immutable; create a new plan' using errcode = 'P0005';
  end if;
  -- One automatic plan per token at a time, or a deposit would be enrolled twice.
  if new.auto_enroll and new.status = 'active' and old.status <> 'active'
     and exists (select 1 from public.return_plans p where p.token_id = new.token_id and p.auto_enroll and p.status = 'active' and p.id <> new.id) then
    raise exception 'another automatic plan is already active for this token; close it first' using errcode = 'P0005';
  end if;
  return new;
end $$;
create trigger return_plans_auto_enroll_immutable before update on public.return_plans
  for each row execute function private.return_plans_auto_enroll_immutable();

alter table public.plan_subscriptions
  add column source_line_id bigint unique references public.journal_lines (id),
  add column source_offchain_entry_id bigint unique references public.offchain_entries (id),
  add column principal_received_at timestamptz,
  add constraint one_source check (source_line_id is null or source_offchain_entry_id is null),
  add constraint offline_source_is_offline check (source_offchain_entry_id is null or funding = 'offline'),
  add constraint platform_source_is_platform check (source_line_id is null or funding = 'platform');

create or replace function private.plan_subscriptions_source_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if new.source_line_id is distinct from old.source_line_id or new.source_offchain_entry_id is distinct from old.source_offchain_entry_id
       or new.principal_received_at is distinct from old.principal_received_at then
      raise exception 'a subscription''s source is immutable' using errcode = 'P0005';
    end if;
    return new;
  end if;
  -- The worker inserts only automatic enrolments into an active automatic plan.
  if pg_has_role(session_user, 'app_worker', 'member') and not pg_has_role(session_user, 'app_web', 'member') then
    if (new.source_line_id is null and new.source_offchain_entry_id is null)
       or not exists (select 1 from public.return_plans p where p.id = new.plan_id and p.auto_enroll and p.status = 'active') then
      raise exception 'the worker may only enrol deposits into an active automatic plan' using errcode = 'P0005';
    end if;
  end if;
  return new;
end $$;
create trigger plan_subscriptions_source_guard before insert or update on public.plan_subscriptions
  for each row execute function private.plan_subscriptions_source_guard();

grant insert (user_id, plan_id, token_id, principal_base, client_key, funding, offline_reference, recorded_by, source_line_id, source_offchain_entry_id, principal_received_at)
  on public.plan_subscriptions to app_worker;
-- Offline sources are read to enrol them.
grant select on public.offchain_entries, public.offchain_holders to app_worker;

revoke execute on function private.return_plans_auto_enroll_immutable(), private.plan_subscriptions_source_guard() from public, anon, authenticated;
grant execute on function private.return_plans_auto_enroll_immutable(), private.plan_subscriptions_source_guard() to app_web, app_worker;
