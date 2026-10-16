-- =============================================================================
-- Treasury snapshots, reconciliation, risk events, audit log, notifications,
-- rate limiting.
-- =============================================================================

create table public.reconciliation_runs (
  id             bigint generated always as identity primary key,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  status         text not null check (status in ('running', 'ok', 'discrepancy', 'error')),
  triggered_by   text not null,
  checks         jsonb not null default '[]'::jsonb,
  summary        jsonb not null default '{}'::jsonb,
  auto_paused    boolean not null default false
);
create index reconciliation_runs_started_idx on public.reconciliation_runs (started_at desc);

create table public.treasury_snapshots (
  id                    bigint generated always as identity primary key,
  reconciliation_run_id bigint references public.reconciliation_runs (id),
  network_id            smallint not null references public.supported_networks (id),
  token_id              smallint not null references public.supported_tokens (id),
  onchain_balance_base  numeric(78,0),            -- null if the chain read failed
  ledger_treasury_base  numeric(78,0) not null,
  virtual_venue_net_base numeric(78,0) not null default 0,
  in_flight_out_base    numeric(78,0) not null default 0,
  customer_liabilities_base numeric(78,0) not null,
  pool_assets_base      numeric(78,0) not null default 0,
  discrepancy_base      numeric(78,0),
  wallets               jsonb not null default '[]'::jsonb,
  taken_at              timestamptz not null default now()
);
create index treasury_snapshots_taken_idx on public.treasury_snapshots (taken_at desc);

create type public.risk_severity as enum ('info', 'low', 'medium', 'high', 'critical');

create table public.risk_events (
  id            bigint generated always as identity primary key,
  user_id       uuid references auth.users (id) on delete restrict,
  kind          text not null,
  severity      public.risk_severity not null,
  subject_type  text not null,
  subject_id    text not null,
  details       jsonb not null default '{}'::jsonb,
  status        text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  resolved_by   uuid references auth.users (id),
  resolution_note text,
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz
);
create index risk_events_open_idx on public.risk_events (severity, created_at desc) where status <> 'resolved';
create index risk_events_user_idx on public.risk_events (user_id, created_at desc);

-- Append-only audit log of every sensitive action.
create table public.audit_events (
  id            bigint generated always as identity primary key,
  actor_type    text not null check (actor_type in ('user', 'staff', 'service', 'system')),
  actor_id      text not null,
  action        text not null,
  subject_type  text,
  subject_id    text,
  ip            inet,
  user_agent    text,
  details       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create index audit_events_created_idx on public.audit_events (created_at desc);
create index audit_events_subject_idx on public.audit_events (subject_type, subject_id);
create index audit_events_actor_idx on public.audit_events (actor_id, created_at desc);
create trigger audit_events_immutable before update or delete on public.audit_events
  for each row execute function private.forbid_mutation();

create table public.notification_events (
  id           bigint generated always as identity primary key,
  user_id      uuid references auth.users (id) on delete cascade,
  audience     text not null default 'user' check (audience in ('user', 'operations')),
  kind         text not null,
  channel      text not null check (channel in ('email', 'in_app')),
  payload      jsonb not null default '{}'::jsonb,
  status       text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts     integer not null default 0,
  dedupe_key   text unique,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz,
  read_at      timestamptz
);
create index notification_events_user_idx on public.notification_events (user_id, created_at desc);
create index notification_events_pending_idx on public.notification_events (created_at) where status = 'pending';

-- Fixed-window rate limiting shared by all app instances.
create table public.rate_limits (
  bucket        text not null,
  window_start  timestamptz not null,
  count         integer not null default 0,
  primary key (bucket, window_start)
);

create or replace function public.rate_limit_hit(p_bucket text, p_window_seconds integer, p_limit integer)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_count integer;
begin
  insert into public.rate_limits as r (bucket, window_start, count) values (p_bucket, v_window, 1)
  on conflict (bucket, window_start) do update set count = r.count + 1
  returning count into v_count;
  if random() < 0.01 then
    delete from public.rate_limits where window_start < now() - interval '1 day';
  end if;
  return v_count <= p_limit;
end $$;
