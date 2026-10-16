-- =============================================================================
-- Investment pool: unitized accounting, trade executions, valuations, allocations.
--
-- Model (documented in docs/accounting.md):
--   * Customers hold units of a pool. Pool NAV = gross asset value - accrued fees.
--   * NAV per unit (navpu) is struck once per valuation. Subscriptions and
--     redemptions requested before a strike execute at that strike's navpu
--     (forward pricing), so new money never receives gains earned before it joined.
--   * Units: numeric(48,18). navpu: token base units per unit, numeric(48,18).
--   * Rounding: subscription units and redemption cash both round DOWN; the
--     residual stays in the pool for remaining unit holders.
-- =============================================================================

create table public.investment_pools (
  id              smallint generated always as identity primary key,
  code            text not null unique,
  name            text not null,
  token_id        smallint not null references public.supported_tokens (id),
  status          public.listing_status not null default 'active',
  is_simulated    boolean not null,  -- true = performance comes from a simulated venue
  venue           text not null,
  inception_navpu numeric(48,18) not null check (inception_navpu > 0),
  high_water_mark numeric(48,18) not null check (high_water_mark > 0),
  created_at      timestamptz not null default now()
);

alter table public.ledger_accounts
  add constraint ledger_accounts_pool_fk foreign key (pool_id) references public.investment_pools (id);

create table public.investment_positions (
  id               bigint generated always as identity primary key,
  pool_id          smallint not null references public.investment_pools (id),
  user_id          uuid not null references auth.users (id) on delete restrict,
  units            numeric(48,18) not null default 0 check (units >= 0),
  units_locked     numeric(48,18) not null default 0 check (units_locked >= 0), -- pending redemption
  cost_basis_base  numeric(78,0) not null default 0 check (cost_basis_base >= 0),
  updated_at       timestamptz not null default now(),
  unique (pool_id, user_id),
  constraint locked_le_units check (units_locked <= units)
);
create trigger investment_positions_touch before update on public.investment_positions
  for each row execute function private.touch_updated_at();

create type public.order_kind as enum ('subscription', 'redemption');
create type public.order_status as enum ('pending', 'executed', 'cancelled');

create table public.investment_orders (
  id               uuid primary key default gen_random_uuid(),
  pool_id          smallint not null references public.investment_pools (id),
  user_id          uuid not null references auth.users (id) on delete restrict,
  kind             public.order_kind not null,
  status           public.order_status not null default 'pending',
  amount_base      numeric(78,0) check (amount_base > 0),   -- subscription cash in (request); redemption cash out (result)
  units            numeric(48,18) check (units > 0),        -- redemption units (request); subscription units (result)
  navpu            numeric(48,18),
  valuation_id     bigint,
  request_entry_id bigint references public.journal_entries (id),
  execute_entry_id bigint unique references public.journal_entries (id),
  realized_pnl_base numeric(78,0),                          -- redemption: cash out - cost basis released (signed)
  cost_basis_released_base numeric(78,0),
  idempotency_key  text not null unique,
  requested_at     timestamptz not null default now(),
  executed_at      timestamptz,
  constraint request_shape check (
    (kind = 'subscription' and amount_base is not null) or (kind = 'redemption' and units is not null)
  )
);
create index investment_orders_pending_idx on public.investment_orders (pool_id, requested_at) where status = 'pending';
create index investment_orders_user_idx on public.investment_orders (user_id, requested_at desc);

-- Executions imported from the trading venue. (venue, external id) is the dedupe key.
create table public.trade_import_batches (
  id            bigint generated always as identity primary key,
  pool_id       smallint not null references public.investment_pools (id),
  venue         text not null,
  requested_by  text not null,
  window_start  timestamptz,
  window_end    timestamptz,
  received      integer not null default 0,
  inserted      integer not null default 0,
  duplicates    integer not null default 0,
  rejected      integer not null default 0,
  errors        jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now()
);

create table public.trade_executions (
  id                    bigint generated always as identity primary key,
  pool_id               smallint not null references public.investment_pools (id),
  venue                 text not null,
  external_execution_id text not null,
  order_ref             text,
  trade_ref             text,
  symbol                text not null check (symbol ~ '^[A-Z0-9]+/[A-Z0-9]+$'), -- BASE/QUOTE
  side                  text not null check (side in ('buy', 'sell')),
  quantity              numeric(48,18) not null check (quantity > 0),
  price                 numeric(48,18) not null check (price > 0),
  fee                   numeric(48,18) not null default 0 check (fee >= 0),
  fee_asset             text not null,
  funding_cost          numeric(48,18) not null default 0,  -- quote currency; positive = cost
  executed_at           timestamptz not null,
  import_batch_id       bigint references public.trade_import_batches (id),
  is_simulated          boolean not null,
  raw                   jsonb not null default '{}'::jsonb,
  imported_at           timestamptz not null default now(),
  unique (venue, external_execution_id)
);
create index trade_executions_pool_idx on public.trade_executions (pool_id, executed_at);
create trigger trade_executions_immutable before update or delete on public.trade_executions
  for each row execute function private.forbid_mutation();

create type public.valuation_status as enum ('final', 'failed');

create table public.portfolio_valuations (
  id                      bigint generated always as identity primary key,
  pool_id                 smallint not null references public.investment_pools (id),
  valuation_date          date not null,
  period_key              text not null,   -- '2026-10-17' (daily) or '2026-10-17T13' (hourly, dev)
  valued_at               timestamptz not null default now(),
  status                  public.valuation_status not null,
  failure_reason          text,
  cash_base               numeric(78,0),
  positions_value_base    numeric(78,0),
  gross_asset_value_base  numeric(78,0),
  fees_accrued_period_base numeric(78,0),
  fees_payable_base       numeric(78,0),
  nav_base                numeric(78,0),
  units_outstanding       numeric(48,18),
  navpu                   numeric(48,18),
  navpu_previous          numeric(48,18),
  realized_pnl_cum_base   numeric(78,0),   -- signed
  unrealized_pnl_base     numeric(78,0),   -- signed
  realized_pnl_period_base   numeric(78,0),
  unrealized_change_period_base numeric(78,0),
  positions               jsonb not null default '[]'::jsonb,
  prices                  jsonb not null default '{}'::jsonb,
  price_source            text,
  fee_policy_version_id   bigint references public.policy_versions (id),
  is_simulated            boolean not null,
  journal_entry_ids       bigint[] not null default '{}',
  created_at              timestamptz not null default now()
);
-- One final valuation per pool per period; failed attempts are kept for audit.
create unique index portfolio_valuations_final_uq on public.portfolio_valuations (pool_id, period_key) where status = 'final';
create index portfolio_valuations_pool_idx on public.portfolio_valuations (pool_id, valued_at desc);

alter table public.investment_orders
  add constraint investment_orders_valuation_fk foreign key (valuation_id) references public.portfolio_valuations (id);

-- Per-user share of each period's investment result (units held at period start
-- x change in navpu). Signed amounts: losses are negative.
create table public.performance_allocations (
  id                   bigint generated always as identity primary key,
  valuation_id         bigint not null references public.portfolio_valuations (id),
  pool_id              smallint not null references public.investment_pools (id),
  user_id              uuid not null references auth.users (id) on delete restrict,
  units_held           numeric(48,18) not null,
  navpu_start          numeric(48,18) not null,
  navpu_end            numeric(48,18) not null,
  pnl_base             numeric(78,0) not null,
  realized_share_base  numeric(78,0) not null,
  unrealized_share_base numeric(78,0) not null,
  fees_share_base      numeric(78,0) not null,
  is_simulated         boolean not null,
  created_at           timestamptz not null default now(),
  unique (valuation_id, user_id)
);
create index performance_allocations_user_idx on public.performance_allocations (user_id, created_at desc);

-- Movements of capital between treasury and the trading venue.
create table public.treasury_transfers (
  id               bigint generated always as identity primary key,
  kind             text not null check (kind in ('to_venue', 'from_venue', 'hot_to_cold', 'cold_to_hot', 'sweep')),
  token_id         smallint not null references public.supported_tokens (id),
  pool_id          smallint references public.investment_pools (id),
  network_id       smallint references public.supported_networks (id),
  from_address     text,
  to_address       text,
  amount_base      numeric(78,0) not null check (amount_base > 0),
  status           text not null check (status in ('pending', 'completed', 'failed')),
  tx_hash          text,
  fee_native_base  numeric(78,0),
  is_virtual       boolean not null,  -- simulated venue: tokens did not move on chain
  journal_entry_id bigint references public.journal_entries (id),
  external_ref     text,
  source_type      text not null,
  source_id        text not null,
  created_at       timestamptz not null default now(),
  completed_at     timestamptz,
  unique (source_type, source_id, kind)
);

-- -----------------------------------------------------------------------------
-- Simulated trading venue state (development only). The simulated venue writes
-- its executions here; the import job then reads them through the same
-- TradingVenue interface a real exchange integration would implement.
-- -----------------------------------------------------------------------------
create table public.sim_venue_executions (
  id                    bigint generated always as identity primary key,
  pool_id               smallint not null references public.investment_pools (id),
  external_execution_id text not null unique,
  order_ref             text not null,
  symbol                text not null,
  side                  text not null check (side in ('buy', 'sell')),
  quantity              numeric(48,18) not null check (quantity > 0),
  price                 numeric(48,18) not null check (price > 0),
  fee                   numeric(48,18) not null,
  fee_asset             text not null,
  executed_at           timestamptz not null,
  created_at            timestamptz not null default now()
);
create index sim_venue_executions_pool_idx on public.sim_venue_executions (pool_id, executed_at);
