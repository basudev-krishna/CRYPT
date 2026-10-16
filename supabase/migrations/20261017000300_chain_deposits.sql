-- =============================================================================
-- Blockchain observation, deposit addresses, deposits, treasury wallets.
-- =============================================================================

create type public.wallet_kind as enum ('hot', 'cold', 'deposit');

-- Addresses the platform controls through its custody provider.
create table public.treasury_wallets (
  id               integer generated always as identity primary key,
  network_id       smallint not null references public.supported_networks (id),
  kind             public.wallet_kind not null,
  address          text not null,
  label            text not null,
  custody_provider text not null,
  custody_ref      text,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  unique (network_id, address)
);

create table public.deposit_addresses (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete restrict,
  network_id       smallint not null references public.supported_networks (id),
  address          text not null,
  custody_provider text not null,
  custody_ref      text,
  status           text not null default 'active' check (status in ('active', 'retired')),
  created_at       timestamptz not null default now(),
  unique (network_id, address)
);
create unique index deposit_addresses_active_uq on public.deposit_addresses (user_id, network_id) where status = 'active';

-- Every on-chain token transfer the platform has observed that touches one of
-- its addresses. One row per (network, tx, log index) - the dedupe key.
create type public.chain_tx_status as enum ('detected', 'confirming', 'confirmed', 'failed', 'reorged');
create type public.chain_direction as enum ('inbound', 'outbound');

create table public.chain_transactions (
  id               bigint generated always as identity primary key,
  network_id       smallint not null references public.supported_networks (id),
  tx_hash          text not null,
  log_index        integer not null default 0,
  block_number     bigint,
  block_hash       text,
  from_address     text not null,
  to_address       text not null,
  token_contract   text,                 -- as observed on chain
  token_id         smallint references public.supported_tokens (id), -- null = not on the allowlist
  amount_base      numeric(78,0) not null check (amount_base >= 0),
  direction        public.chain_direction not null,
  confirmations    integer not null default 0,
  status           public.chain_tx_status not null default 'detected',
  receipt_success  boolean,
  is_simulated     boolean not null default false,
  raw              jsonb not null default '{}'::jsonb,
  first_seen_at    timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (network_id, tx_hash, log_index)
);
create index chain_transactions_to_idx on public.chain_transactions (network_id, to_address);
create index chain_transactions_open_idx on public.chain_transactions (network_id, status) where status in ('detected', 'confirming');
create trigger chain_transactions_touch before update on public.chain_transactions
  for each row execute function private.touch_updated_at();

create table public.network_scan_state (
  network_id          smallint primary key references public.supported_networks (id),
  last_scanned_block  bigint not null default 0,
  updated_at          timestamptz not null default now()
);

create type public.deposit_status as enum (
  'awaiting_deposit', 'detected', 'confirming', 'confirmed', 'credited', 'under_review', 'failed', 'recovery_required'
);

create table public.deposits (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid references auth.users (id) on delete restrict, -- null if address unknown (recovery)
  network_id             smallint not null references public.supported_networks (id),
  token_id               smallint references public.supported_tokens (id),
  deposit_address_id     uuid references public.deposit_addresses (id),
  chain_transaction_id   bigint not null unique references public.chain_transactions (id),
  amount_base            numeric(78,0) not null check (amount_base >= 0),
  status                 public.deposit_status not null,
  status_reason          text,
  confirmations          integer not null default 0,
  required_confirmations integer not null,
  risk_result            jsonb,
  credit_entry_id        bigint unique references public.journal_entries (id),
  suspense_entry_id      bigint unique references public.journal_entries (id),
  policy_version_id      bigint references public.policy_versions (id),
  detected_at            timestamptz not null default now(),
  confirmed_at           timestamptz,
  credited_at            timestamptz,
  updated_at             timestamptz not null default now(),
  constraint credited_has_entry check (status <> 'credited' or credit_entry_id is not null)
);
create index deposits_user_idx on public.deposits (user_id, detected_at desc);
create index deposits_status_idx on public.deposits (status) where status not in ('credited', 'failed');
create trigger deposits_touch before update on public.deposits
  for each row execute function private.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Simulated chain (development only). Lets the full deposit/withdrawal flow run
-- without external RPCs. Everything that touches it is labelled SIMULATED.
-- Block height advances with wall-clock time (one block every 4 seconds).
-- -----------------------------------------------------------------------------
create table public.sim_chain_transfers (
  id             bigint generated always as identity primary key,
  network_id     smallint not null references public.supported_networks (id),
  tx_hash        text not null unique,
  block_number   bigint not null,
  token_contract text not null,
  from_address   text not null,
  to_address     text not null,
  amount_base    numeric(78,0) not null check (amount_base > 0),
  success        boolean not null default true,
  created_at     timestamptz not null default now()
);
create index sim_chain_transfers_block_idx on public.sim_chain_transfers (network_id, block_number);

create or replace function public.sim_block_number() returns bigint
language sql stable as $$
  select floor(extract(epoch from now()) / 4)::bigint - 440000000
$$;
