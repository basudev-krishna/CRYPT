/** Read models for the staff console. Callers must have passed requireStaff(). */
import { many, maybeOne, one, type Db } from '../db-core';
import { parseBase } from '@/lib/money';

export async function adminOverview(db: Db) {
  const r = await one<{
    users: number;
    kyc_pending: number;
    deposits_credited: number;
    deposits_credited_sum: string;
    deposits_open: number;
    withdrawals_open: number;
    withdrawals_open_sum: string;
    withdrawals_review: number;
    treasury: string;
    pool_assets: string;
    liabilities: string;
    fee_revenue: string;
  }>(
    db,
    `select
       (select count(*)::int from public.user_profiles) as users,
       (select count(*)::int from public.user_kyc_current where status = 'pending') as kyc_pending,
       (select count(*)::int from public.deposits where status = 'credited') as deposits_credited,
       (select coalesce(sum(amount_base), 0)::text from public.deposits where status = 'credited') as deposits_credited_sum,
       (select count(*)::int from public.deposits where status in ('detected', 'confirming', 'confirmed', 'under_review', 'recovery_required')) as deposits_open,
       (select count(*)::int from public.withdrawal_requests where status in ('reserved', 'processing', 'broadcast')) as withdrawals_open,
       (select coalesce(sum(amount_base), 0)::text from public.withdrawal_requests where status in ('reserved', 'processing', 'broadcast')) as withdrawals_open_sum,
       (select count(*)::int from public.withdrawal_requests where status = 'reserved' and requires_manual_review and reviewed_by is null) as withdrawals_review,
       (select coalesce(sum(b.balance), 0)::text from public.ledger_accounts a join public.account_balances b on b.account_id = a.id where a.purpose in ('treasury_hot', 'treasury_cold')) as treasury,
       (select coalesce(sum(b.balance), 0)::text from public.ledger_accounts a join public.account_balances b on b.account_id = a.id where a.purpose = 'pool_assets') as pool_assets,
       (select coalesce(sum(b.balance), 0)::text from public.ledger_accounts a join public.account_balances b on b.account_id = a.id
         where a.purpose in ('user_cash', 'user_reserved', 'user_pending_subscription', 'pool_investor_equity', 'suspense_deposits')) as liabilities,
       (select coalesce(sum(b.balance), 0)::text from public.ledger_accounts a join public.account_balances b on b.account_id = a.id where a.purpose = 'fee_revenue') as fee_revenue`,
  );
  const nav = await maybeOne<{ nav_base: string; navpu: string; realized_pnl_cum_base: string; unrealized_pnl_base: string; valued_at: Date; is_simulated: boolean; status: string }>(
    db,
    `select nav_base::text, navpu::text, realized_pnl_cum_base::text, unrealized_pnl_base::text, valued_at, is_simulated, status::text
       from public.portfolio_valuations where status = 'final' order by valued_at desc limit 1`,
  );
  const lastValuation = await maybeOne<{ status: string; failure_reason: string | null; valued_at: Date }>(
    db,
    'select status::text, failure_reason, valued_at from public.portfolio_valuations order by valued_at desc limit 1',
  );
  const recon = await maybeOne<{ id: string; status: string; started_at: Date; auto_paused: boolean }>(
    db,
    'select id, status, started_at, auto_paused from public.reconciliation_runs order by started_at desc limit 1',
  );
  const risk = await many<{ severity: string; n: number }>(db, "select severity::text, count(*)::int as n from public.risk_events where status <> 'resolved' group by severity");
  const controls = await many<{ key: string; enabled: boolean; reason: string | null; updated_by: string; updated_at: Date }>(
    db,
    'select key, enabled, reason, updated_by, updated_at from public.system_controls order by key',
  );
  return {
    users: r.users,
    kycPending: r.kyc_pending,
    depositsCredited: r.deposits_credited,
    depositsCreditedSum: parseBase(r.deposits_credited_sum),
    depositsOpen: r.deposits_open,
    withdrawalsOpen: r.withdrawals_open,
    withdrawalsOpenSum: parseBase(r.withdrawals_open_sum),
    withdrawalsReview: r.withdrawals_review,
    treasuryAssets: parseBase(r.treasury),
    poolAssets: parseBase(r.pool_assets),
    customerLiabilities: parseBase(r.liabilities),
    feeRevenue: parseBase(r.fee_revenue),
    nav: nav
      ? { nav: parseBase(nav.nav_base), navpu: nav.navpu, realized: parseBase(nav.realized_pnl_cum_base), unrealized: parseBase(nav.unrealized_pnl_base), at: nav.valued_at, isSimulated: nav.is_simulated }
      : null,
    lastValuation,
    reconciliation: recon,
    risk: Object.fromEntries(risk.map((x) => [x.severity, x.n])) as Record<string, number>,
    controls,
  };
}

export async function adminUsers(db: Db, search: string | null, limit = 50) {
  return many<{ user_id: string; email: string; account_status: string; kyc: string | null; created_at: Date; cash: string; roles: string[] | null }>(
    db,
    `select p.user_id, p.email, p.account_status, k.status::text as kyc, p.created_at,
            coalesce((select sum(cash_base) from public.user_ledger_balances b where b.user_id = p.user_id), 0)::text as cash,
            (select array_agg(role::text) from public.staff_roles r where r.user_id = p.user_id) as roles
       from public.user_profiles p left join public.user_kyc_current k on k.user_id = p.user_id
      where ($1::text is null or p.email ilike '%' || $1 || '%' or p.user_id::text = $1)
      order by p.created_at desc limit $2`,
    [search, limit],
  );
}

export async function adminUserDetail(db: Db, userId: string) {
  const profile = await maybeOne<Record<string, unknown>>(db, 'select * from public.user_profiles where user_id = $1', [userId]);
  if (!profile) return null;
  const [kyc, risk, positions, balances] = await Promise.all([
    many(db, 'select id, status, level, full_name, country_code, document_type, document_last4, submitted_at, reviewed_at, review_notes, created_at from public.kyc_records where user_id = $1 order by created_at desc', [userId]),
    many(db, 'select id, kind, severity, status, created_at, details from public.risk_events where user_id = $1 order by created_at desc limit 50', [userId]),
    many(db, 'select pool_id, units::text, units_locked::text, cost_basis_base::text from public.investment_positions where user_id = $1', [userId]),
    many(db, 'select token_id, cash_base::text, reserved_base::text, pending_subscription_base::text from public.user_ledger_balances where user_id = $1', [userId]),
  ]);
  return { profile, kyc, risk, positions, balances };
}

export async function adminKycQueue(db: Db) {
  return many<{ id: string; user_id: string; email: string; full_name: string | null; country_code: string | null; document_type: string | null; document_last4: string | null; submitted_at: Date | null }>(
    db,
    `select k.id, k.user_id, p.email, k.full_name, k.country_code, k.document_type, k.document_last4, k.submitted_at
       from public.user_kyc_current c join public.kyc_records k on k.id = c.kyc_record_id join public.user_profiles p on p.user_id = k.user_id
      where c.status = 'pending' order by k.submitted_at limit 100`,
  );
}

export async function adminDeposits(db: Db, status: string | null, limit = 100) {
  return many<{
    id: string;
    user_id: string | null;
    email: string | null;
    status: string;
    status_reason: string | null;
    amount_base: string;
    confirmations: number;
    required_confirmations: number;
    tx_hash: string;
    from_address: string;
    network: string;
    detected_at: Date;
    risk_result: unknown;
    is_simulated: boolean;
  }>(
    db,
    `select d.id, d.user_id, p.email, d.status::text, d.status_reason, d.amount_base::text, d.confirmations, d.required_confirmations,
            c.tx_hash, c.from_address, n.code as network, d.detected_at, d.risk_result, c.is_simulated
       from public.deposits d join public.chain_transactions c on c.id = d.chain_transaction_id
       join public.supported_networks n on n.id = d.network_id left join public.user_profiles p on p.user_id = d.user_id
      where ($1::text is null or d.status::text = $1) order by d.detected_at desc limit $2`,
    [status, limit],
  );
}

export async function adminWithdrawals(db: Db, status: string | null, limit = 100) {
  return many<{
    id: string;
    user_id: string;
    email: string;
    status: string;
    status_reason: string | null;
    amount_base: string;
    fee_base: string;
    destination_address: string;
    requires_manual_review: boolean;
    compliance_hold: boolean;
    reviewed_by: string | null;
    created_at: Date;
    risk_result: unknown;
    tx_hash: string | null;
    attempts: number;
    is_simulated: boolean;
  }>(
    db,
    `select w.id, w.user_id, p.email, w.status::text, w.status_reason, w.amount_base::text, w.fee_base::text, w.destination_address,
            w.requires_manual_review, w.compliance_hold, w.reviewed_by, w.created_at, w.risk_result, w.is_simulated,
            (select tx_hash from public.withdrawal_transactions t where t.withdrawal_id = w.id order by attempt desc limit 1) as tx_hash,
            (select count(*)::int from public.withdrawal_transactions t where t.withdrawal_id = w.id) as attempts
       from public.withdrawal_requests w join public.user_profiles p on p.user_id = w.user_id
      where ($1::text is null or w.status::text = $1) order by w.created_at desc limit $2`,
    [status, limit],
  );
}

export async function adminTreasury(db: Db) {
  const latest = await maybeOne<{ id: string }>(db, "select id from public.reconciliation_runs where status <> 'running' order by started_at desc limit 1");
  const snapshots = latest
    ? await many<Record<string, unknown>>(
        db,
        `select s.*, n.code as network, t.symbol, t.decimals from public.treasury_snapshots s
           join public.supported_networks n on n.id = s.network_id join public.supported_tokens t on t.id = s.token_id
          where s.reconciliation_run_id = $1`,
        [latest.id],
      )
    : [];
  const wallets = await many(db, 'select w.id, n.code as network, w.kind::text, w.address, w.label, w.custody_provider, w.is_active from public.treasury_wallets w join public.supported_networks n on n.id = w.network_id order by w.id');
  const transfers = await many(db, 'select id, kind, amount_base::text, status, is_virtual, tx_hash, created_at, source_type, source_id from public.treasury_transfers order by created_at desc limit 50');
  return { snapshots, wallets, transfers };
}

export async function adminReconciliationRuns(db: Db, limit = 30) {
  return many<{ id: string; started_at: Date; finished_at: Date | null; status: string; triggered_by: string; checks: unknown; auto_paused: boolean }>(
    db,
    'select id, started_at, finished_at, status, triggered_by, checks, auto_paused from public.reconciliation_runs order by started_at desc limit $1',
    [limit],
  );
}

export async function adminTrading(db: Db) {
  const [valuations, trades, batches] = await Promise.all([
    many(
      db,
      `select id, period_key, valued_at, status::text, failure_reason, gross_asset_value_base::text, nav_base::text, navpu::text,
              units_outstanding::text, realized_pnl_period_base::text, unrealized_change_period_base::text, fees_accrued_period_base::text,
              positions, price_source, is_simulated,
              (select count(*)::int from public.performance_allocations a where a.valuation_id = v.id) as allocations
         from public.portfolio_valuations v order by valued_at desc limit 50`,
    ),
    many(
      db,
      'select id, venue, external_execution_id, symbol, side, quantity::text, price::text, fee::text, fee_asset, executed_at, is_simulated from public.trade_executions order by executed_at desc limit 100',
    ),
    many(db, 'select id, venue, received, inserted, duplicates, rejected, errors, created_at from public.trade_import_batches order by created_at desc limit 30'),
  ]);
  return { valuations, trades, batches };
}

export async function adminAuditEvents(db: Db, filter: { actor?: string | null; action?: string | null }, limit = 200) {
  return many<{ id: string; actor_type: string; actor_id: string; action: string; subject_type: string | null; subject_id: string | null; ip: string | null; details: unknown; created_at: Date }>(
    db,
    `select id, actor_type, actor_id, action, subject_type, subject_id, host(ip) as ip, details, created_at from public.audit_events
      where ($1::text is null or actor_id = $1) and ($2::text is null or action ilike $2 || '%')
      order by id desc limit $3`,
    [filter.actor ?? null, filter.action ?? null, limit],
  );
}

export async function adminRiskEvents(db: Db, includeResolved = false) {
  return many<{ id: string; user_id: string | null; kind: string; severity: string; subject_type: string; subject_id: string; status: string; details: unknown; created_at: Date }>(
    db,
    `select id, user_id, kind, severity::text, subject_type, subject_id, status, details, created_at from public.risk_events
      where ($1 or status <> 'resolved') order by created_at desc limit 200`,
    [includeResolved],
  );
}

export async function adminPolicies(db: Db) {
  return many<{ id: string; kind: string; version: number; params: unknown; effective_from: Date; change_note: string; created_by: string; approved_by: string | null }>(
    db,
    'select id, kind::text, version, params, effective_from, change_note, created_by, approved_by from public.policy_versions order by kind, version desc',
  );
}
