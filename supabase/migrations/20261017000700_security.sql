-- =============================================================================
-- Access control
--
-- * anon / authenticated (Supabase API roles): RLS on every table. Customers can
--   read only their own rows from a small set of tables, and can write nothing.
--   The application does not depend on these grants; they are defense in depth
--   in case the public anon key is used directly against PostgREST.
-- * app_web (Next.js server) and app_worker (background workers): explicit,
--   table-level grants. Neither can write ledger tables directly; all ledger
--   writes go through SECURITY DEFINER functions in schema `ledger`.
-- =============================================================================

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    -- Backend roles are authorized by table grants below, not by RLS.
    execute format('create policy backend_all on public.%I to app_web, app_worker using (true) with check (true)', t);
  end loop;
end $$;

-- Public reference data.
grant select on public.supported_networks, public.supported_tokens, public.investment_pools to anon, authenticated;
create policy public_read on public.supported_networks for select to anon, authenticated using (status <> 'disabled');
create policy public_read on public.supported_tokens for select to anon, authenticated using (status <> 'disabled');
create policy public_read on public.investment_pools for select to anon, authenticated using (true);

-- Customer read-own policies.
do $$
declare t text;
begin
  foreach t in array array[
    'user_profiles', 'kyc_records', 'deposit_addresses', 'deposits', 'withdrawal_requests',
    'investment_positions', 'investment_orders', 'performance_allocations', 'notification_events'
  ] loop
    execute format('grant select on public.%I to authenticated', t);
    execute format('create policy own_rows on public.%I for select to authenticated using (user_id = (select auth.uid()))', t);
  end loop;
end $$;

revoke all on public.user_kyc_current, public.user_ledger_balances, public.ledger_trial_balance from anon, authenticated;

-- Functions: Supabase grants EXECUTE to anon/authenticated by default.
revoke execute on all functions in schema public, ledger, private from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Backend grants
-- -----------------------------------------------------------------------------
grant select on all tables in schema public to app_web, app_worker;
grant execute on function
  ledger.ensure_account(public.account_purpose, smallint, uuid, smallint),
  ledger.post_entry(text, text, text, text, text, text, jsonb, jsonb, bigint),
  ledger.journal_balance(bigint),
  ledger.lock_balance(bigint),
  ledger.normal_side(public.account_type),
  ledger.is_customer_purpose(public.account_purpose),
  ledger.purpose_type(public.account_purpose),
  public.current_policy(public.policy_kind),
  public.rate_limit_hit(text, integer, integer),
  public.sim_block_number()
to app_web, app_worker;
-- Internal helpers invoked from triggers run with the caller's privileges.
grant execute on all functions in schema private to app_web, app_worker;
-- Reversals are an exceptional operation: only workers (via the admin-approved
-- adjustment job) may call it.
grant execute on function ledger.reverse_entry(bigint, text, text) to app_worker;

-- Web: customer requests and staff operations.
grant insert, update on public.user_profiles to app_web;
grant insert on public.kyc_records to app_web;
grant insert on public.deposit_addresses to app_web;
grant update on public.deposits to app_web;
grant insert, update on public.withdrawal_requests, public.withdrawal_destinations to app_web;
grant insert, update on public.investment_orders, public.investment_positions to app_web;
grant insert on public.audit_events to app_web, app_worker;
grant insert, update on public.risk_events, public.notification_events to app_web, app_worker;
grant update on public.system_controls to app_web, app_worker;
grant insert on public.policy_versions to app_web;
grant insert, delete on public.staff_roles to app_web;
grant update (status) on public.supported_networks, public.supported_tokens to app_web;
grant insert on public.sim_chain_transfers to app_web, app_worker;

-- Worker: chain ingestion, crediting, trading, valuation, payouts, reconciliation.
grant insert, update on
  public.chain_transactions, public.network_scan_state, public.deposits,
  public.trade_import_batches, public.portfolio_valuations, public.performance_allocations,
  public.investment_orders, public.investment_positions, public.treasury_transfers,
  public.withdrawal_requests, public.withdrawal_transactions,
  public.reconciliation_runs, public.treasury_snapshots
to app_worker;
grant update (verified_at) on public.withdrawal_destinations to app_worker;
grant insert on public.trade_executions, public.deposit_addresses, public.treasury_wallets, public.sim_venue_executions to app_worker;
grant update on public.investment_pools to app_worker;

-- Explicitly: no direct writes to the ledger.
revoke insert, update, delete, truncate on public.journal_entries, public.journal_lines,
  public.account_balances, public.ledger_accounts from app_web, app_worker;

-- pg-boss creates and owns its schema when the worker first starts.
do $$ begin
  execute format('grant create on database %I to app_worker', current_database());
end $$;

-- gen_random_bytes / digest live in the extensions schema on Supabase.
grant usage on schema extensions to app_web, app_worker;
