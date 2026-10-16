-- =============================================================================
-- Foundation: backend roles, reference data (networks/tokens), user profiles,
-- staff roles, KYC, system controls and versioned policies.
--
-- Conventions
--   * All token amounts are integer base units stored as numeric(78,0)
--     (78 digits fits any uint256). Never floats.
--   * Assets are identified by supported_tokens.id (network + contract), never
--     by symbol.
--   * auth.users (Supabase Auth) is the "users" table.
-- =============================================================================

create extension if not exists pgcrypto with schema extensions;

-- Least-privilege backend roles. Passwords are set outside migrations
-- (supabase/seed.sql for local dev, secret manager in production).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_web') then
    create role app_web nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_worker') then
    create role app_worker nologin;
  end if;
end $$;

create schema if not exists ledger;
create schema if not exists private;
revoke all on schema ledger, private from public, anon, authenticated;
grant usage on schema ledger, private to app_web, app_worker;
grant usage on schema public to app_web, app_worker;

-- Generic updated_at trigger.
create or replace function private.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- -----------------------------------------------------------------------------
-- Networks and tokens (explicit allowlist)
-- -----------------------------------------------------------------------------
create type public.network_family as enum ('evm', 'tron', 'simulated');
create type public.listing_status as enum ('active', 'paused', 'disabled');

create table public.supported_networks (
  id                      smallint generated always as identity primary key,
  code                    text not null unique check (code ~ '^[a-z0-9-]+$'),
  name                    text not null,
  family                  public.network_family not null,
  chain_id                bigint,
  is_testnet              boolean not null,
  required_confirmations  integer not null check (required_confirmations > 0),
  status                  public.listing_status not null default 'disabled',
  explorer_tx_url         text,           -- e.g. https://sepolia.etherscan.io/tx/{hash}
  address_format          text not null default 'evm' check (address_format in ('evm', 'tron')),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  -- Phase guard: a mainnet network can never be activated by data alone.
  constraint mainnet_not_active check (is_testnet or status <> 'active'),
  constraint evm_has_chain_id check (family <> 'evm' or chain_id is not null)
);
create unique index supported_networks_chain_uq on public.supported_networks (family, chain_id) where chain_id is not null;
create trigger supported_networks_touch before update on public.supported_networks
  for each row execute function private.touch_updated_at();

create table public.supported_tokens (
  id                 smallint generated always as identity primary key,
  network_id         smallint not null references public.supported_networks (id),
  symbol             text not null,      -- display only; never used for identity
  name               text not null,
  contract_address   text,               -- null only for the native gas asset
  decimals           smallint not null check (decimals between 0 and 36),
  is_native          boolean not null default false,
  is_test_token      boolean not null,
  status             public.listing_status not null default 'disabled',
  min_deposit_base   numeric(78,0) not null default 0 check (min_deposit_base >= 0),
  min_withdrawal_base numeric(78,0) not null default 0 check (min_withdrawal_base >= 0),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint native_xor_contract check (is_native = (contract_address is null)),
  -- EVM contracts are stored lower-case so lookups are exact.
  constraint contract_normalized check (contract_address is null or contract_address = lower(contract_address) or contract_address !~ '^0x')
);
create unique index supported_tokens_contract_uq on public.supported_tokens (network_id, contract_address) where contract_address is not null;
create unique index supported_tokens_native_uq on public.supported_tokens (network_id) where is_native;
create trigger supported_tokens_touch before update on public.supported_tokens
  for each row execute function private.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Users, profiles, staff roles
-- -----------------------------------------------------------------------------
create type public.account_status as enum ('active', 'restricted', 'frozen', 'closed');

create table public.user_profiles (
  user_id            uuid primary key references auth.users (id) on delete restrict,
  email              text not null,
  display_name       text,
  country_code       char(2),
  account_status     public.account_status not null default 'active',
  restriction_reason text,
  risk_disclosure_accepted_at timestamptz,
  risk_disclosure_version     text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index user_profiles_email_idx on public.user_profiles (lower(email));
create trigger user_profiles_touch before update on public.user_profiles
  for each row execute function private.touch_updated_at();

-- Create a profile for every new auth user.
create or replace function private.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.user_profiles (user_id, email) values (new.id, coalesce(new.email, ''))
  on conflict (user_id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_auth_user();

create type public.staff_role as enum ('admin', 'operations', 'compliance', 'read_only');

create table public.staff_roles (
  user_id     uuid not null references auth.users (id) on delete cascade,
  role        public.staff_role not null,
  granted_by  uuid references auth.users (id),
  granted_at  timestamptz not null default now(),
  primary key (user_id, role)
);

-- -----------------------------------------------------------------------------
-- KYC (append-only history; the latest row is the current status)
-- -----------------------------------------------------------------------------
create type public.kyc_status as enum ('not_started', 'pending', 'approved', 'rejected', 'expired');

create table public.kyc_records (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete restrict,
  status         public.kyc_status not null,
  level          text not null default 'basic',
  provider       text not null default 'manual',
  provider_ref   text,
  full_name      text,
  date_of_birth  date,
  country_code   char(2),
  document_type  text,
  document_last4 text,
  submitted_at   timestamptz,
  reviewed_by    uuid references auth.users (id),
  reviewed_at    timestamptz,
  review_notes   text,
  created_at     timestamptz not null default now()
);
create index kyc_records_user_idx on public.kyc_records (user_id, created_at desc);
create index kyc_records_pending_idx on public.kyc_records (created_at) where status = 'pending';

create view public.user_kyc_current with (security_invoker = true) as
select distinct on (user_id) user_id, id as kyc_record_id, status, level, created_at
from public.kyc_records
order by user_id, created_at desc, id;

-- -----------------------------------------------------------------------------
-- System controls (emergency pauses) and versioned policies
-- -----------------------------------------------------------------------------
create table public.system_controls (
  key         text primary key check (key in ('withdrawals_paused', 'deposits_paused', 'allocations_paused')),
  enabled     boolean not null default false,
  reason      text,
  updated_by  text not null default 'system',
  updated_at  timestamptz not null default now()
);
insert into public.system_controls (key, enabled) values
  ('withdrawals_paused', false), ('deposits_paused', false), ('allocations_paused', false);

create type public.policy_kind as enum ('withdrawal', 'deposit', 'fee', 'allocation');

-- Policies are never edited in place: a change inserts a new version.
create table public.policy_versions (
  id              bigint generated always as identity primary key,
  kind            public.policy_kind not null,
  version         integer not null check (version > 0),
  params          jsonb not null,
  effective_from  timestamptz not null default now(),
  change_note     text not null,
  created_by      text not null,
  approved_by     text,
  created_at      timestamptz not null default now(),
  unique (kind, version)
);
create index policy_versions_effective_idx on public.policy_versions (kind, effective_from desc);

create or replace function private.forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% on % is not allowed (append-only table)', tg_op, tg_table_name
    using errcode = 'P0001';
end $$;
create trigger policy_versions_immutable before update or delete on public.policy_versions
  for each row execute function private.forbid_mutation();

create or replace function public.current_policy(p_kind public.policy_kind)
returns public.policy_versions language sql stable as $$
  select * from public.policy_versions
  where kind = p_kind and effective_from <= now()
  order by effective_from desc, version desc limit 1
$$;
