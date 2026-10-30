-- =============================================================================
-- Fixed daily returns: principal and payments settled offline
--
-- Most members hand their principal to the company's team offline and are
-- paid their returns offline. The platform keeps the record and the display:
--
-- * An offline subscription is opened by a staff member for a member, with a
--   reference to the offline receipt. Its principal never enters the
--   double-entry ledger (no wallet money backs it), so it is never withdrawable
--   here and never counted in custody solvency. Returning it is also offline.
-- * Its daily returns accrue on the ledger exactly like any other
--   (D return_cost / C return_accrued -> return_payable): they are what the
--   company owes, whatever way it pays.
-- * A staff member records an offline payment of a member's due returns
--   through a date: D return_payable / C return_cost per accrual. Nothing is
--   credited to available balance, so no withdrawable money is created, and
--   an offline payment is never shown as a blockchain payment.
-- * Offline subscriptions are never paid from the on-chain revenue reserve,
--   so a return can't be paid twice.
-- =============================================================================

alter table public.plan_subscriptions
  add column funding text not null default 'platform' check (funding in ('platform', 'offline')),
  add column offline_reference text,
  add column recorded_by uuid references auth.users (id),
  add constraint offline_is_recorded check (funding = 'platform' or (recorded_by is not null and char_length(btrim(coalesce(offline_reference, ''))) >= 5));

alter table public.plan_subscriptions drop constraint opened_has_entry;
alter table public.plan_subscriptions add constraint opened_has_entry check (
  status in ('pending', 'failed', 'cancelled')
  or (activated_at is not null and accrual_start_date is not null and (funding = 'offline' or open_entry_id is not null)));
alter table public.plan_subscriptions drop constraint redeemed_has_entry;
alter table public.plan_subscriptions add constraint redeemed_has_entry check (
  (status = 'redeemed') = (redeemed_at is not null and (funding = 'offline' or redeem_entry_id is not null)));
alter table public.plan_subscriptions add constraint offline_has_no_entries check (funding = 'platform' or (open_entry_id is null and redeem_entry_id is null));

create or replace function private.plan_subscriptions_immutable_funding() returns trigger
language plpgsql as $$
begin
  if new.funding <> old.funding or new.offline_reference is distinct from old.offline_reference or new.recorded_by is distinct from old.recorded_by then
    raise exception 'how a subscription was funded is immutable' using errcode = 'P0005';
  end if;
  return new;
end $$;
create trigger plan_subscriptions_immutable_funding before update on public.plan_subscriptions
  for each row execute function private.plan_subscriptions_immutable_funding();

grant insert (user_id, plan_id, token_id, principal_base, client_key, funding, offline_reference, recorded_by) on public.plan_subscriptions to app_web;

-- -----------------------------------------------------------------------------
-- Offline payments of due returns
-- -----------------------------------------------------------------------------
create table public.offline_return_payments (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete restrict,
  token_id      smallint not null references public.supported_tokens (id),
  through_date  date not null,                         -- covers due returns earned up to and including this day
  note          text not null check (char_length(btrim(note)) >= 10),
  recorded_by   uuid not null references auth.users (id),
  created_at    timestamptz not null default now(),
  status        text not null default 'pending' check (status in ('pending', 'posted', 'failed', 'cancelled')),
  amount_base   numeric(78,0) check (amount_base is null or amount_base > 0),  -- what was covered, set when posted
  accruals      integer check (accruals is null or accruals > 0),
  posted_at     timestamptz,
  error         text,
  constraint posted_fields check ((status = 'posted') = (amount_base is not null and accruals is not null and posted_at is not null))
);
create index offline_return_payments_user_idx on public.offline_return_payments (user_id, created_at desc);

create or replace function private.offline_return_payments_guard() returns trigger
language plpgsql as $$
begin
  if new.user_id <> old.user_id or new.token_id <> old.token_id or new.through_date <> old.through_date or new.note <> old.note
     or new.recorded_by <> old.recorded_by or new.created_at <> old.created_at then
    raise exception 'offline payments are immutable apart from their status' using errcode = 'P0005';
  end if;
  if old.status <> 'pending' then
    raise exception 'offline payment % is already %', old.id, old.status using errcode = 'P0005';
  end if;
  if pg_has_role(session_user, 'app_web', 'member') and not pg_has_role(session_user, 'app_worker', 'member') and new.status <> 'cancelled' then
    raise exception 'only a pending offline payment can be cancelled' using errcode = 'P0005';
  end if;
  return new;
end $$;
create trigger offline_return_payments_guard before update on public.offline_return_payments
  for each row execute function private.offline_return_payments_guard();
create trigger offline_return_payments_no_delete before delete on public.offline_return_payments
  for each row execute function private.forbid_mutation();

alter table public.return_accruals add column offline_payment_id uuid references public.offline_return_payments (id);
grant update (offline_payment_id) on public.return_accruals to app_worker;
-- An accrual is settled either from the reserve into available balance, or offline; never both.
create or replace function private.return_accruals_offline_guard() returns trigger
language plpgsql as $$
begin
  if old.offline_payment_id is not null and new.offline_payment_id is distinct from old.offline_payment_id then
    raise exception 'an offline payment is recorded once' using errcode = 'P0005';
  end if;
  if new.offline_payment_id is not null and new.status <> 'settled' then
    raise exception 'an offline payment settles the accrual' using errcode = 'P0005';
  end if;
  return new;
end $$;
create trigger return_accruals_offline_guard before update on public.return_accruals
  for each row execute function private.return_accruals_offline_guard();

alter table public.offline_return_payments enable row level security;
revoke all on public.offline_return_payments from anon, authenticated;
create policy backend_all on public.offline_return_payments to app_web, app_worker using (true) with check (true);
grant select on public.offline_return_payments to authenticated;
create policy own_rows on public.offline_return_payments for select to authenticated using (user_id = (select auth.uid()));
grant select on public.offline_return_payments to app_web, app_worker;
grant insert (user_id, token_id, through_date, note, recorded_by) on public.offline_return_payments to app_web;
grant update (status, error) on public.offline_return_payments to app_web;
grant update (status, amount_base, accruals, posted_at, error) on public.offline_return_payments to app_worker;

revoke execute on function private.plan_subscriptions_immutable_funding(), private.offline_return_payments_guard(), private.return_accruals_offline_guard() from public, anon, authenticated;
grant execute on function private.plan_subscriptions_immutable_funding(), private.offline_return_payments_guard(), private.return_accruals_offline_guard() to app_web, app_worker;
