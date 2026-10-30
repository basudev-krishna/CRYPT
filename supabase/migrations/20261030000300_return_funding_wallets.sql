-- =============================================================================
-- Fixed daily returns: company funding wallets
--
-- The company's team sends USDT to the group wallet every day to fund members'
-- daily returns. An administrator registers those sending addresses once; the
-- worker then records each receipt from them as business revenue
-- (allocation 'business_revenue' -> return_reserve) without a manual step, and
-- the daily settlement credits members' available balances from it.
--
-- A funding wallet can never be a member's wallet, in either direction, so a
-- member's deposit can never be counted as company funding.
-- =============================================================================

create table public.return_funding_wallets (
  id           uuid primary key default gen_random_uuid(),
  network_id   smallint not null references public.supported_networks (id),
  address      text not null check (address ~ '^0x[0-9a-f]{40}$'),
  label        text not null check (char_length(btrim(label)) between 3 and 80),
  status       text not null default 'active' check (status in ('active', 'removed')),
  added_by     uuid not null references auth.users (id),
  created_at   timestamptz not null default now(),
  removed_by   uuid references auth.users (id),
  removed_at   timestamptz,
  remove_note  text,
  constraint removed_fields check ((status = 'removed') = (removed_by is not null and removed_at is not null))
);
create unique index return_funding_wallets_active_uq on public.return_funding_wallets (network_id, address) where status = 'active';

-- Refuse an address that belongs to a member, or has ever funded a member's deposit.
create or replace function private.return_funding_wallets_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if new.network_id <> old.network_id or new.address <> old.address or new.label <> old.label or new.added_by <> old.added_by or new.created_at <> old.created_at then
      raise exception 'funding wallets are immutable apart from removal' using errcode = 'P0005';
    end if;
    if not (old.status = 'active' and new.status = 'removed') then
      raise exception 'a funding wallet can only be removed' using errcode = 'P0005';
    end if;
    return new;
  end if;
  if exists (select 1 from public.member_wallets w where w.network_id = new.network_id and w.address = new.address and w.status = 'active') then
    raise exception 'this address is a member wallet' using errcode = 'P0005';
  end if;
  if exists (select 1 from public.deposits d join public.chain_transactions c on c.id = d.chain_transaction_id
              where c.network_id = new.network_id and lower(c.from_address) = new.address and d.user_id is not null) then
    raise exception 'this address has funded a member deposit' using errcode = 'P0005';
  end if;
  if exists (select 1 from public.treasury_wallets t where t.network_id = new.network_id and lower(t.address) = new.address)
     or exists (select 1 from public.deposit_addresses a where a.network_id = new.network_id and lower(a.address) = new.address) then
    raise exception 'platform wallets cannot be funding wallets' using errcode = 'P0005';
  end if;
  return new;
end $$;
create trigger return_funding_wallets_guard before insert or update on public.return_funding_wallets
  for each row execute function private.return_funding_wallets_guard();
create trigger return_funding_wallets_no_delete before delete on public.return_funding_wallets
  for each row execute function private.forbid_mutation();

-- The other direction: a member cannot register a company funding wallet.
create or replace function private.member_wallets_not_funding() returns trigger
language plpgsql as $$
begin
  if new.status = 'active' and exists (select 1 from public.return_funding_wallets f
                                        where f.network_id = new.network_id and f.address = new.address and f.status = 'active') then
    raise exception 'this address is a company funding wallet' using errcode = 'P0005';
  end if;
  return new;
end $$;
create trigger member_wallets_not_funding before insert or update on public.member_wallets
  for each row execute function private.member_wallets_not_funding();

-- -----------------------------------------------------------------------------
-- The worker may create exactly one kind of allocation: business revenue from
-- an active funding wallet. Everything else stays an administrator's decision.
-- -----------------------------------------------------------------------------
create or replace function private.allocations_insert_guard() returns trigger
language plpgsql as $$
begin
  if pg_has_role(session_user, 'app_worker', 'member') and not pg_has_role(session_user, 'app_web', 'member') then
    if new.kind <> 'business_revenue' or not exists (
         select 1 from public.deposits d
           join public.chain_transactions c on c.id = d.chain_transaction_id
           join public.return_funding_wallets f on f.network_id = c.network_id and f.address = lower(c.from_address) and f.status = 'active'
          where d.id = new.deposit_id and d.user_id is null) then
      raise exception 'the worker may only record receipts from a company funding wallet' using errcode = 'P0005';
    end if;
  end if;
  return new;
end $$;
create trigger allocations_insert_guard before insert on public.allocations
  for each row execute function private.allocations_insert_guard();

alter table public.return_funding_wallets enable row level security;
revoke all on public.return_funding_wallets from anon, authenticated;
create policy backend_all on public.return_funding_wallets to app_web, app_worker using (true) with check (true);
grant select on public.return_funding_wallets to app_web, app_worker;
grant insert (network_id, address, label, added_by) on public.return_funding_wallets to app_web;
grant update (status, removed_by, removed_at, remove_note) on public.return_funding_wallets to app_web;

grant insert (deposit_id, kind, reason, created_by) on public.allocations to app_worker;
grant insert (allocation_id, business_line, period_start, period_end, evidence_reference, created_by) on public.business_revenue_records to app_worker;

revoke execute on function private.return_funding_wallets_guard(), private.member_wallets_not_funding(), private.allocations_insert_guard() from public, anon, authenticated;
grant execute on function private.return_funding_wallets_guard(), private.member_wallets_not_funding(), private.allocations_insert_guard() to app_web, app_worker;
