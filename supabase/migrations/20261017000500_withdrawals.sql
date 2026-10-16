-- =============================================================================
-- Withdrawals: requests, payout transactions, destination tracking.
--
-- State machine (enforced by private.withdrawal_transition_ok):
--   requested -> pending_verification -> reserved -> processing -> broadcast -> confirmed
--   pending_verification|reserved -> cancelled (user)    reserved -> rejected (policy/compliance)
--   processing|broadcast -> failed (reservation released only when the payout is proven not executed)
--   broadcast -> processing (custody proved the attempt was dropped; a replacement attempt is created)
-- =============================================================================

create type public.withdrawal_status as enum (
  'requested', 'pending_verification', 'reserved', 'processing', 'broadcast',
  'confirmed', 'rejected', 'failed', 'cancelled'
);

create table public.withdrawal_requests (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references auth.users (id) on delete restrict,
  network_id              smallint not null references public.supported_networks (id),
  token_id                smallint not null references public.supported_tokens (id),
  destination_address     text not null,
  amount_base             numeric(78,0) not null check (amount_base > 0), -- debited from the customer
  fee_base                numeric(78,0) not null check (fee_base >= 0),   -- platform withdrawal fee
  net_amount_base         numeric(78,0) not null check (net_amount_base > 0), -- sent on chain
  status                  public.withdrawal_status not null default 'requested',
  status_reason           text,
  policy_version_id       bigint references public.policy_versions (id),
  risk_result             jsonb,
  requires_manual_review  boolean not null default false,
  compliance_hold         boolean not null default false,
  reviewed_by             uuid references auth.users (id),
  reviewed_at             timestamptz,
  idempotency_key         text not null unique,
  reserve_entry_id        bigint unique references public.journal_entries (id),
  settle_entry_id         bigint unique references public.journal_entries (id),
  release_entry_id        bigint unique references public.journal_entries (id),
  confirmed_by_user_at    timestamptz,
  is_simulated            boolean not null default false,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint net_plus_fee check (net_amount_base + fee_base = amount_base),
  constraint one_terminal_entry check (settle_entry_id is null or release_entry_id is null)
);
create index withdrawal_requests_user_idx on public.withdrawal_requests (user_id, created_at desc);
create index withdrawal_requests_open_idx on public.withdrawal_requests (status)
  where status in ('pending_verification', 'reserved', 'processing', 'broadcast');
create trigger withdrawal_requests_touch before update on public.withdrawal_requests
  for each row execute function private.touch_updated_at();

create or replace function private.withdrawal_transition_ok(p_from public.withdrawal_status, p_to public.withdrawal_status)
returns boolean language sql immutable as $$
  select p_from = p_to or (p_from, p_to) in (
    ('requested', 'pending_verification'),
    ('requested', 'rejected'),
    ('pending_verification', 'reserved'),
    ('pending_verification', 'cancelled'),
    ('pending_verification', 'rejected'),
    ('reserved', 'processing'),
    ('reserved', 'rejected'),
    ('reserved', 'cancelled'),
    ('processing', 'broadcast'),
    ('processing', 'failed'),
    ('processing', 'reserved'),  -- custody proved nothing was signed; back to queue
    ('broadcast', 'confirmed'),
    ('broadcast', 'failed'),
    ('broadcast', 'processing')  -- previous attempt proven dropped; replacement attempt
  )
$$;

create or replace function private.enforce_withdrawal_transition() returns trigger
language plpgsql as $$
begin
  if not private.withdrawal_transition_ok(old.status, new.status) then
    raise exception 'illegal withdrawal transition % -> %', old.status, new.status using errcode = 'P0004';
  end if;
  if old.status in ('confirmed', 'rejected', 'failed', 'cancelled') and new is distinct from old then
    raise exception 'withdrawal % is final', old.id using errcode = 'P0004';
  end if;
  if new.amount_base <> old.amount_base or new.fee_base <> old.fee_base
     or new.destination_address <> old.destination_address or new.user_id <> old.user_id then
    raise exception 'withdrawal amounts and destination are immutable' using errcode = 'P0004';
  end if;
  return new;
end $$;
create trigger withdrawal_requests_transition before update on public.withdrawal_requests
  for each row execute function private.enforce_withdrawal_transition();

-- One row per payout attempt sent to custody. A new attempt is only allowed
-- after the previous one is proven failed/dropped (see withdrawal service).
create table public.withdrawal_transactions (
  id                  bigint generated always as identity primary key,
  withdrawal_id       uuid not null references public.withdrawal_requests (id),
  attempt             integer not null check (attempt > 0),
  custody_provider    text not null,
  custody_request_id  text not null unique,   -- our idempotency key sent to custody
  custody_tx_id       text,
  tx_hash             text,
  status              text not null check (status in ('submitted', 'broadcast', 'confirmed', 'failed', 'dropped', 'replaced')),
  confirmations       integer not null default 0,
  fee_native_base     numeric(78,0),
  error               text,
  is_simulated        boolean not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (withdrawal_id, attempt)
);
create unique index withdrawal_transactions_one_live on public.withdrawal_transactions (withdrawal_id)
  where status in ('submitted', 'broadcast', 'confirmed');
create trigger withdrawal_transactions_touch before update on public.withdrawal_transactions
  for each row execute function private.touch_updated_at();

create table public.withdrawal_destinations (
  id             bigint generated always as identity primary key,
  user_id        uuid not null references auth.users (id) on delete restrict,
  network_id     smallint not null references public.supported_networks (id),
  address        text not null,
  label          text,
  first_seen_at  timestamptz not null default now(),
  verified_at    timestamptz,
  usable_after   timestamptz not null,   -- cooldown for new addresses
  unique (user_id, network_id, address)
);
