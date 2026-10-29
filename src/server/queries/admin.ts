/** Read models for the staff console. Callers must have passed requireStaff(). */
import { many, maybeOne, one, type Db } from '../db-core';
import { parseBase } from '@/lib/money';
import { FIRST_CREDITED_AT_SQL, referralStage, type ReferralStage } from './user';

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
  return many<{ user_id: string; email: string; member_code: string; sponsor_code: string | null; account_status: string; kyc: string | null; created_at: Date; cash: string; roles: string[] | null }>(
    db,
    `select p.user_id, p.email, p.member_code, s.member_code as sponsor_code, p.account_status, k.status::text as kyc, p.created_at,
            coalesce((select sum(cash_base) from public.user_ledger_balances b where b.user_id = p.user_id), 0)::text as cash,
            (select array_agg(role::text) from public.staff_roles r where r.user_id = p.user_id) as roles
       from public.user_profiles p left join public.user_kyc_current k on k.user_id = p.user_id
       left join public.user_profiles s on s.user_id = p.sponsor_user_id
      where ($1::text is null or p.email ilike '%' || $1 || '%' or p.user_id::text = $1 or p.member_code = upper($1))
      order by p.created_at desc limit $2`,
    [search, limit],
  );
}

export interface AdminReferral {
  userId: string;
  email: string;
  memberCode: string;
  joinedAt: Date;
  stage: ReferralStage;
  firstCreditedAt: Date | null;
  sponsorUserId: string;
  sponsorEmail: string;
  sponsorMemberCode: string;
}

/** Every recorded referral (sponsor link), newest first, with its qualification stage. */
export async function adminReferrals(db: Db, limit = 500): Promise<AdminReferral[]> {
  const rows = await many<{
    user_id: string;
    email: string;
    member_code: string;
    created_at: Date;
    account_status: string;
    first_credited_at: Date | null;
    sponsor_user_id: string;
    sponsor_email: string;
    sponsor_code: string;
  }>(
    db,
    `select p.user_id, p.email, p.member_code, p.created_at, p.account_status::text as account_status,
            ${FIRST_CREDITED_AT_SQL} as first_credited_at,
            s.user_id as sponsor_user_id, s.email as sponsor_email, s.member_code as sponsor_code
       from public.user_profiles p join public.user_profiles s on s.user_id = p.sponsor_user_id
      order by p.created_at desc limit $1`,
    [limit],
  );
  return rows.map((r) => ({
    userId: r.user_id,
    email: r.email,
    memberCode: r.member_code,
    joinedAt: r.created_at,
    stage: referralStage(r.account_status, r.first_credited_at),
    firstCreditedAt: r.first_credited_at,
    sponsorUserId: r.sponsor_user_id,
    sponsorEmail: r.sponsor_email,
    sponsorMemberCode: r.sponsor_code,
  }));
}

export async function adminInvitations(db: Db, limit = 100) {
  return many<{
    id: string;
    email: string;
    status: 'pending' | 'accepted' | 'revoked';
    expired: boolean;
    sponsor_code: string | null;
    member_code: string | null;
    note: string;
    created_by: string;
    created_at: Date;
    expires_at: Date;
    accepted_at: Date | null;
    revoked_at: Date | null;
    revoke_reason: string | null;
  }>(
    db,
    `select i.id, i.email, i.status, (i.status = 'pending' and i.expires_at <= now()) as expired,
            s.member_code as sponsor_code, m.member_code, i.note, i.created_by, i.created_at, i.expires_at,
            i.accepted_at, i.revoked_at, i.revoke_reason
       from public.member_invitations i
       left join public.user_profiles s on s.user_id = i.sponsor_user_id
       left join public.user_profiles m on m.user_id = i.accepted_user_id
      order by i.created_at desc limit $1`,
    [limit],
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
    decimals: number | null;
    credit_entry_id: string | null;
    group_wallet: boolean;
    allocation_status: string | null;
    correction_pending: boolean;
  }>(
    db,
    `select d.id, d.user_id, p.email, d.status::text, d.status_reason, d.amount_base::text, d.confirmations, d.required_confirmations,
            c.tx_hash, c.from_address, n.code as network, d.detected_at, d.risk_result, c.is_simulated,
            t.decimals, d.credit_entry_id, d.treasury_wallet_id is not null as group_wallet,
            (select a.status from public.allocations a where a.deposit_id = d.id and a.status in ('pending', 'posted') limit 1) as allocation_status,
            exists (select 1 from public.deposit_corrections k where k.deposit_id = d.id and k.status = 'pending') as correction_pending
       from public.deposits d join public.chain_transactions c on c.id = d.chain_transaction_id
       join public.supported_networks n on n.id = d.network_id left join public.user_profiles p on p.user_id = d.user_id
       left join public.supported_tokens t on t.id = d.token_id
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

export interface SignupRow {
  user_id: string;
  email: string;
  member_code: string;
  display_name: string | null;
  username: string | null;
  phone: string | null;
  country_code: string | null;
  sponsor_code: string | null;
  account_status: 'pending_approval' | 'rejected' | 'active' | 'restricted' | 'frozen' | 'closed';
  restriction_reason: string | null;
  created_at: Date;
  reviewed_at: Date | null;
  reviewed_by_email: string | null;
}

/** The approval queue: every pending or rejected sign-up, plus decisions from the last 30 days. */
export async function adminSignups(db: Db): Promise<SignupRow[]> {
  return many<SignupRow>(
    db,
    `select p.user_id, p.email, p.member_code, p.display_name, p.username, p.phone, p.country_code, s.member_code as sponsor_code,
            p.account_status::text as account_status, p.restriction_reason, p.created_at, p.reviewed_at, r.email as reviewed_by_email
       from public.user_profiles p
       left join public.user_profiles r on r.user_id = p.reviewed_by
       left join public.user_profiles s on s.user_id = p.sponsor_user_id
      where p.account_status in ('pending_approval', 'rejected')
         or p.reviewed_at > now() - interval '30 days'
      order by (p.account_status = 'pending_approval') desc, coalesce(p.reviewed_at, p.created_at) desc
      limit 500`,
  );
}

/** Sign-up counts for the overview, including new accounts per day for the last 14 days (UTC). */
export async function signupStats(db: Db) {
  const totals = await one<{ pending: number; approved_7d: number; rejected_7d: number; oldest_pending: Date | null }>(
    db,
    `select count(*) filter (where account_status = 'pending_approval')::int as pending,
            count(*) filter (where account_status <> 'rejected' and reviewed_at > now() - interval '7 days')::int as approved_7d,
            count(*) filter (where account_status = 'rejected' and reviewed_at > now() - interval '7 days')::int as rejected_7d,
            min(created_at) filter (where account_status = 'pending_approval') as oldest_pending
       from public.user_profiles`,
  );
  const daily = await many<{ day: string; n: number }>(
    db,
    `select to_char(d, 'YYYY-MM-DD') as day, count(p.user_id)::int as n
       from generate_series((now() at time zone 'utc')::date - 13, (now() at time zone 'utc')::date, interval '1 day') d
       left join public.user_profiles p on (p.created_at at time zone 'utc')::date = d::date
      group by d order by d`,
  );
  return { pending: totals.pending, approved7d: totals.approved_7d, rejected7d: totals.rejected_7d, oldestPending: totals.oldest_pending, daily };
}

/** The queue in the serializable shape the interactive client component takes. */
export async function adminSignupQueue(db: Db) {
  return (await adminSignups(db)).map((r) => ({
    userId: r.user_id,
    email: r.email,
    memberCode: r.member_code,
    fullName: r.display_name,
    username: r.username,
    phone: r.phone,
    country: r.country_code,
    referredBy: r.sponsor_code,
    status: r.account_status,
    reason: r.restriction_reason,
    createdAt: r.created_at.toISOString(),
    reviewedAt: r.reviewed_at?.toISOString() ?? null,
    reviewedBy: r.reviewed_by_email,
  }));
}

/** Active members, for choosing allocation recipients. */
export async function adminActiveMembers(db: Db) {
  return many<{ user_id: string; email: string | null; member_code: string; display_name: string | null; username: string | null }>(
    db,
    `select user_id, email, member_code, display_name, username from public.user_profiles
      where account_status = 'active' order by member_code`,
  );
}

/** Referral rewards for review, open ones first. */
export async function adminReferralRewards(db: Db, limit = 200) {
  return many<{
    id: string;
    status: 'pending' | 'approved' | 'rejected' | 'posted';
    amount_base: string;
    symbol: string;
    decimals: number;
    sponsor_user_id: string;
    sponsor_email: string;
    sponsor_code: string;
    referred_email: string;
    referred_code: string;
    qualified_at: Date;
    created_at: Date;
    review_note: string | null;
    reviewed_at: Date | null;
    posted_at: Date | null;
    error: string | null;
    policy_version: number;
  }>(
    db,
    `select r.id, r.status, r.amount_base::text, t.symbol, t.decimals, r.sponsor_user_id, s.email as sponsor_email, s.member_code as sponsor_code,
            p.email as referred_email, p.member_code as referred_code, r.qualified_at, r.created_at, r.review_note, r.reviewed_at, r.posted_at, r.error,
            v.version as policy_version
       from public.referral_rewards r
       join public.user_profiles s on s.user_id = r.sponsor_user_id
       join public.user_profiles p on p.user_id = r.referred_user_id
       join public.supported_tokens t on t.id = r.token_id
       join public.policy_versions v on v.id = r.policy_version_id
      order by (r.status in ('pending', 'approved')) desc, r.created_at desc limit $1`,
    [limit],
  );
}

/** Referral reward fund balance per token, with what approved-but-unpaid rewards still need. */
export async function referralFundBalances(db: Db) {
  return many<{ token_id: number; symbol: string; decimals: number; balance: string; approved_unpaid: string }>(
    db,
    `select t.id as token_id, t.symbol, t.decimals,
            coalesce((select sum(b.balance) from public.ledger_accounts a join public.account_balances b on b.account_id = a.id
                       where a.purpose = 'referral_reward_fund' and a.token_id = t.id), 0)::text as balance,
            coalesce((select sum(r.amount_base) from public.referral_rewards r where r.token_id = t.id and r.status = 'approved'), 0)::text as approved_unpaid
       from public.supported_tokens t
      where exists (select 1 from public.ledger_accounts a where a.purpose = 'referral_reward_fund' and a.token_id = t.id)
         or exists (select 1 from public.referral_rewards r where r.token_id = t.id)
      order by t.id`,
  );
}

/** Referral policy version history, newest first. */
export async function referralPolicyHistory(db: Db) {
  return many<{ version: number; params: Record<string, unknown>; change_note: string; created_by: string; created_at: Date }>(
    db,
    "select version, params, change_note, created_by, created_at from public.policy_versions where kind = 'referral' order by version desc limit 20",
  );
}

export interface ManualAddition {
  source: 'held' | 'platform';
  id: string;
  user_id: string;
  email: string | null;
  member_code: string | null;
  display_name: string | null;
  kind: string;
  /** Signed: negative for subtractions. */
  amount: string;
  decimals: number;
  symbol: string;
  reason: string;
  status: string;
  created_at: Date;
  created_by_email: string | null;
}

/**
 * Balance changes the administrator made by hand, newest first: entries in
 * members' records held with the administrator (balance edits, rewards,
 * reversals) and platform adjustments against the operator float or reward fund.
 */
export async function adminManualAdditions(db: Db, limit = 100) {
  return many<ManualAddition>(
    db,
    `select * from (
       select 'held' as source, e.id::text, h.user_id, p.email, p.member_code, p.display_name,
              case when to_jsonb(e) ->> 'category' = 'matching_bonus' then 'matching_bonus' else e.kind::text end as kind,
              e.amount_micro::text as amount, 6 as decimals, 'USDT' as symbol, e.reason, 'saved' as status, e.created_at, s.email as created_by_email
         from public.offchain_entries e
         join public.offchain_holders h on h.id = e.holder_id
         join public.user_profiles p on p.user_id = h.user_id
         left join public.user_profiles s on s.user_id = e.created_by
        where e.kind <> 'moved_to_platform'
       union all
       select 'platform', m.id::text, m.user_id, p.email, p.member_code, p.display_name,
              case when m.fund = 'referral_reward_fund' then 'reward' else 'balance' end,
              (case when m.direction = 'debit' then -m.amount_base else m.amount_base end)::text, t.decimals, t.symbol, m.reason, m.status::text, m.created_at, s.email
         from public.manual_adjustments m
         join public.supported_tokens t on t.id = m.token_id
         join public.user_profiles p on p.user_id = m.user_id
         left join public.user_profiles s on s.user_id = m.created_by
     ) x order by created_at desc limit $1`,
    [limit],
  );
}
