-- =============================================================================
-- Private-group operation with a single administrator.
--
-- 1. Allocations. An unattributed group-wallet receipt (in suspense) is either
--    assigned to one member or split among several (a distribution, e.g. profit
--    made elsewhere and sent to the group wallet). An allocation can only spend
--    a receipt that is confirmed on chain, so the ledger can never credit more
--    than the wallet received.
-- 2. Corrections. A credited deposit (automatic or allocated) is reversed back
--    into suspense with a documented reason, then allocated again.
-- 3. Manual payouts. The administrator pays withdrawals from the group wallet
--    with their own wallet software and records the tx hash. The worker settles
--    only after verifying sender, recipient, token and amount on chain.
--
-- With one administrator there is no second approver. The controls are
-- transparency instead: every allocation and correction needs a reason, is
-- written to the audit log, raises a high-severity risk event (Telegram), and
-- is visible to each affected member in their history. Posting is done by the
-- worker, so the web role's ledger scope stays unchanged.
-- =============================================================================

create table public.allocations (
  id            uuid primary key default gen_random_uuid(),
  deposit_id    uuid not null references public.deposits (id),
  kind          text not null check (kind in ('assignment', 'distribution')),
  reason        text not null check (length(trim(reason)) >= 10),
  created_by    uuid not null references auth.users (id),
  created_at    timestamptz not null default now(),
  status        text not null default 'pending' check (status in ('pending', 'posted', 'cancelled', 'failed', 'reversed')),
  entry_id      bigint unique references public.journal_entries (id),
  posted_at     timestamptz,
  error         text,
  constraint posted_has_entry check (status not in ('posted', 'reversed') or entry_id is not null)
);
-- A receipt is allocated at most once at a time.
create unique index allocations_live_uq on public.allocations (deposit_id) where status in ('pending', 'posted');
create index allocations_pending_idx on public.allocations (created_at) where status = 'pending';

create table public.allocation_lines (
  allocation_id uuid not null references public.allocations (id),
  user_id       uuid not null references auth.users (id),
  amount_base   numeric(78,0) not null check (amount_base > 0),
  primary key (allocation_id, user_id)
);
create index allocation_lines_user_idx on public.allocation_lines (user_id);

create table public.deposit_corrections (
  id                 uuid primary key default gen_random_uuid(),
  deposit_id         uuid not null references public.deposits (id),
  reversed_entry_id  bigint not null references public.journal_entries (id),
  reason             text not null check (length(trim(reason)) >= 10),
  created_by         uuid not null references auth.users (id),
  created_at         timestamptz not null default now(),
  status             text not null default 'pending' check (status in ('pending', 'posted', 'failed')),
  reversal_entry_id  bigint unique references public.journal_entries (id),
  error              text
);
create unique index deposit_corrections_live_uq on public.deposit_corrections (reversed_entry_id) where status in ('pending', 'posted');

-- One row per payout attempt the administrator has dealt with: either the hash
-- of the transaction they sent, or a cancellation (nothing was sent).
create table public.manual_payouts (
  custody_request_id text primary key references public.withdrawal_transactions (custody_request_id),
  tx_hash            text unique check (tx_hash ~ '^(sim:)?0x[0-9a-f]{64}$'), -- sim: only on the simulated network
  cancelled          boolean not null default false,
  note               text not null check (length(trim(note)) >= 10),
  recorded_by        uuid not null references auth.users (id),
  recorded_at        timestamptz not null default now(),
  constraint hash_xor_cancel check ((tx_hash is not null) <> cancelled)
);

do $$
declare t text;
begin
  foreach t in array array['allocations', 'allocation_lines', 'deposit_corrections', 'manual_payouts'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('create policy backend_all on public.%I to app_web, app_worker using (true) with check (true)', t);
    execute format('grant select on public.%I to app_web, app_worker', t);
  end loop;
end $$;

-- Members may read their own allocation lines (defense in depth; the app reads via app_web).
grant select on public.allocation_lines to authenticated;
create policy own_rows on public.allocation_lines for select to authenticated using (user_id = (select auth.uid()));

grant insert (deposit_id, kind, reason, created_by) on public.allocations to app_web;
grant insert on public.allocation_lines to app_web;
grant update (status, error) on public.allocations to app_web; -- cancelling a pending allocation
grant insert (deposit_id, reversed_entry_id, reason, created_by) on public.deposit_corrections to app_web;
grant insert (custody_request_id, tx_hash, cancelled, note, recorded_by) on public.manual_payouts to app_web;

grant update (status, entry_id, posted_at, error) on public.allocations to app_worker;
grant update (status, reversal_entry_id, error) on public.deposit_corrections to app_worker;

-- Lines are fixed once written, and only while their allocation is pending.
create or replace function private.allocation_lines_guard() returns trigger
language plpgsql as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'allocation lines are immutable' using errcode = 'P0005';
  end if;
  if not exists (select 1 from public.allocations where id = new.allocation_id and status = 'pending') then
    raise exception 'lines can only be added to a pending allocation' using errcode = 'P0005';
  end if;
  return new;
end $$;
create trigger allocation_lines_guard before insert or update or delete on public.allocation_lines
  for each row execute function private.allocation_lines_guard();

-- The web role may only cancel a pending allocation; every other transition is the worker's.
create or replace function private.allocations_guard() returns trigger
language plpgsql as $$
begin
  if new.deposit_id <> old.deposit_id or new.kind <> old.kind or new.reason <> old.reason or new.created_by <> old.created_by then
    raise exception 'allocations are immutable apart from their status' using errcode = 'P0005';
  end if;
  if pg_has_role(session_user, 'app_web', 'member') and not pg_has_role(session_user, 'app_worker', 'member')
     and not (old.status = 'pending' and new.status = 'cancelled') then
    raise exception 'only a pending allocation can be cancelled' using errcode = 'P0005';
  end if;
  return new;
end $$;
create trigger allocations_guard before update on public.allocations
  for each row execute function private.allocations_guard();

revoke execute on function private.allocation_lines_guard(), private.allocations_guard() from public, anon, authenticated;
grant execute on function private.allocation_lines_guard(), private.allocations_guard() to app_web, app_worker;
