-- =============================================================================
-- Group-wallet deposits.
--
-- Members send USDT to one shared treasury wallet instead of a per-user deposit
-- address. A shared wallet cannot tell senders apart by recipient, so deposits
-- are attributed by SENDER: each member registers the wallets they send from,
-- proving control with a signed message. A transfer from a registered wallet is
-- credited to its owner; any other transfer (exchange withdrawals, unknown
-- senders) is still received into suspense and waits for an admin allocation.
--
-- The app only watches this wallet. It holds no keys for it.
-- =============================================================================

-- A treasury wallet whose inbound transfers are member deposits.
alter table public.treasury_wallets add column receives_deposits boolean not null default false;

create table public.member_wallets (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete restrict,
  network_id      smallint not null references public.supported_networks (id),
  address         text not null check (address = lower(address)),
  -- The exact message the wallet signed and its signature, kept as evidence.
  proof_message   text not null,
  proof_signature text not null,
  status          text not null default 'active' check (status in ('active', 'removed')),
  created_at      timestamptz not null default now(),
  removed_at      timestamptz,
  constraint removed_has_time check (status <> 'removed' or removed_at is not null)
);
-- One owner per sending address at a time, so a transfer maps to at most one member.
create unique index member_wallets_active_uq on public.member_wallets (network_id, address) where status = 'active';
create index member_wallets_user_idx on public.member_wallets (user_id);

-- How a deposit was attributed. Exactly one of these is set for a deposit to a
-- known destination; neither user_id nor member_wallet_id is set for an
-- unattributed group-wallet receipt.
alter table public.deposits add column treasury_wallet_id integer references public.treasury_wallets (id);
alter table public.deposits add column member_wallet_id uuid references public.member_wallets (id);
alter table public.deposits add constraint deposit_has_destination
  check (deposit_address_id is not null or treasury_wallet_id is not null) not valid;
alter table public.deposits validate constraint deposit_has_destination;

alter table public.member_wallets enable row level security;
revoke all on public.member_wallets from anon, authenticated;
create policy backend_all on public.member_wallets to app_web, app_worker using (true) with check (true);
grant select on public.member_wallets to authenticated;
create policy own_rows on public.member_wallets for select to authenticated using (user_id = (select auth.uid()));

grant select on public.member_wallets to app_web, app_worker;
grant insert (user_id, network_id, address, proof_message, proof_signature) on public.member_wallets to app_web;
-- Removal is the only change allowed; address and owner never change.
grant update (status, removed_at) on public.member_wallets to app_web;

-- A removed wallet stays removed: re-adding it needs a fresh signed proof (a new row).
create or replace function private.member_wallets_guard() returns trigger
language plpgsql as $$
begin
  if old.status <> 'active' or new.status <> 'removed' then
    raise exception 'a member wallet can only be removed' using errcode = 'P0005';
  end if;
  return new;
end $$;
create trigger member_wallets_guard before update on public.member_wallets
  for each row execute function private.member_wallets_guard();
revoke execute on function private.member_wallets_guard() from public, anon, authenticated;
grant execute on function private.member_wallets_guard() to app_web, app_worker;
