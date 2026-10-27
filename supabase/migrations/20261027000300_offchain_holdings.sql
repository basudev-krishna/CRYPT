-- =============================================================================
-- Off-platform holdings: money members gave the administrator personally.
--
-- This is a memo ledger, deliberately separate from the double-entry ledger:
-- the money is not in any platform wallet, so it must not appear as customer
-- cash (reconciliation would rightly report the platform as insolvent and
-- pause withdrawals). It is not withdrawable on the site. To make it
-- withdrawable, the administrator sends the money into the group wallet and
-- assigns that receipt to the member (an ordinary allocation); a matching
-- 'moved_to_platform' entry, bound to that allocation, reduces the
-- off-platform balance by the same amount.
--
-- * Holders are recorded by name and may be linked once to a member account,
--   after which the member sees their balance and history.
-- * Entries are append-only (no UPDATE/DELETE, even for the owner). A mistake
--   is corrected by a reversal entry, at most once per entry.
-- * Amounts are micro-USDT (6 decimals) as integers, signed by kind.
-- * A holder's balance can never go negative (checked under a row lock).
-- * Every entry needs a written reason; the application audits and alerts each one.
-- =============================================================================

create table public.offchain_holders (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 2 and 80),
  note        text check (note is null or char_length(note) <= 500),
  user_id     uuid unique references auth.users (id) on delete restrict,
  created_by  uuid not null references auth.users (id),
  created_at  timestamptz not null default now(),
  linked_by   uuid references auth.users (id),
  linked_at   timestamptz,
  constraint linked_fields check ((user_id is null) = (linked_by is null and linked_at is null))
);

create table public.offchain_entries (
  id                 bigint generated always as identity primary key,
  holder_id          uuid not null references public.offchain_holders (id) on delete restrict,
  kind               text not null check (kind in ('contribution', 'earnings', 'payback', 'moved_to_platform', 'adjustment', 'reversal')),
  amount_micro       numeric(78,0) not null check (amount_micro <> 0),
  occurred_on        date not null,
  reason             text not null check (char_length(btrim(reason)) >= 10),
  allocation_id      uuid unique references public.allocations (id),
  reverses_entry_id  bigint unique references public.offchain_entries (id),
  idempotency_key    text not null unique,
  created_by         uuid not null references auth.users (id),
  created_at         timestamptz not null default now(),
  constraint sign_by_kind check (
    (kind in ('contribution', 'earnings') and amount_micro > 0)
    or (kind in ('payback', 'moved_to_platform') and amount_micro < 0)
    or kind in ('adjustment', 'reversal')
  ),
  constraint moved_has_allocation check ((kind = 'moved_to_platform') = (allocation_id is not null)),
  constraint reversal_has_target check ((kind = 'reversal') = (reverses_entry_id is not null))
);
create index offchain_entries_holder_idx on public.offchain_entries (holder_id, id);

-- Entries are immutable; corrections are reversals.
create trigger offchain_entries_no_update before update or delete on public.offchain_entries
  for each row execute function private.forbid_mutation();
create trigger offchain_holders_no_delete before delete on public.offchain_holders
  for each row execute function private.forbid_mutation();

-- A holder's link to an account is set once and never changed.
create or replace function private.offchain_holders_guard() returns trigger
language plpgsql as $$
begin
  if old.user_id is not null and new.user_id is distinct from old.user_id then
    raise exception 'an off-platform holder stays linked to the same account' using errcode = 'P0005';
  end if;
  if new.created_by <> old.created_by or new.created_at <> old.created_at then
    raise exception 'holder origin is immutable' using errcode = 'P0005';
  end if;
  return new;
end $$;
create trigger offchain_holders_guard before update on public.offchain_holders
  for each row execute function private.offchain_holders_guard();

-- Serialize entries per holder and keep the balance non-negative; a reversal
-- must exactly negate an entry of the same holder that is not itself a reversal.
create or replace function private.offchain_entries_check() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_balance numeric(78,0);
  v_target record;
begin
  perform 1 from public.offchain_holders where id = new.holder_id for update;
  if new.kind = 'reversal' then
    select holder_id, kind, amount_micro into v_target from public.offchain_entries where id = new.reverses_entry_id;
    if v_target.holder_id is distinct from new.holder_id or v_target.kind = 'reversal' or new.amount_micro <> -v_target.amount_micro then
      raise exception 'a reversal must exactly negate one entry of the same holder' using errcode = 'P0005';
    end if;
    if v_target.kind = 'moved_to_platform' then
      raise exception 'money moved to the platform is corrected on the platform (deposit correction), not here' using errcode = 'P0005';
    end if;
  end if;
  select coalesce(sum(amount_micro), 0) into v_balance from public.offchain_entries where holder_id = new.holder_id;
  if v_balance + new.amount_micro < 0 then
    raise exception 'off-platform balance cannot go negative' using errcode = 'P0002';
  end if;
  return new;
end $$;
create trigger offchain_entries_check before insert on public.offchain_entries
  for each row execute function private.offchain_entries_check();

alter table public.offchain_holders enable row level security;
alter table public.offchain_entries enable row level security;
revoke all on public.offchain_holders, public.offchain_entries from anon, authenticated;
create policy backend_all on public.offchain_holders to app_web, app_worker using (true) with check (true);
create policy backend_all on public.offchain_entries to app_web, app_worker using (true) with check (true);
-- Linked members may read their own records (defense in depth; the app reads via app_web).
grant select on public.offchain_holders, public.offchain_entries to authenticated;
create policy own_rows on public.offchain_holders for select to authenticated using (user_id = (select auth.uid()));
create policy own_rows on public.offchain_entries for select to authenticated
  using (exists (select 1 from public.offchain_holders h where h.id = holder_id and h.user_id = (select auth.uid())));

grant select on public.offchain_holders, public.offchain_entries to app_web, app_worker;
grant insert (name, note, created_by) on public.offchain_holders to app_web;
grant update (name, note, user_id, linked_by, linked_at) on public.offchain_holders to app_web;
grant insert (holder_id, kind, amount_micro, occurred_on, reason, allocation_id, reverses_entry_id, idempotency_key, created_by)
  on public.offchain_entries to app_web;

revoke execute on function private.offchain_holders_guard(), private.offchain_entries_check() from public, anon, authenticated;
grant execute on function private.offchain_holders_guard(), private.offchain_entries_check() to app_web, app_worker;
