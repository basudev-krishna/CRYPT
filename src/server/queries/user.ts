/**
 * Read models for customer-facing pages and APIs. Every function takes the
 * authenticated user's id from the server session; nothing here accepts a
 * user id from the client.
 */
import { many, maybeOne, type Db } from '../db-core';
import { parseBase, parseFixed } from '@/lib/money';
import { userBalances } from '../ledger/ledger';
import { unitsValue } from '../investment/nav';

export interface TokenView {
  id: number;
  networkId: number;
  symbol: string;
  decimals: number;
  isTestToken: boolean;
  networkCode: string;
  networkName: string;
  isSimulatedNetwork: boolean;
}

export async function listActiveTokens(db: Db): Promise<TokenView[]> {
  const rows = await many<{ id: number; network_id: number; symbol: string; decimals: number; is_test_token: boolean; code: string; name: string; family: string }>(
    db,
    `select t.id, t.network_id, t.symbol, t.decimals, t.is_test_token, n.code, n.name, n.family
       from public.supported_tokens t join public.supported_networks n on n.id = t.network_id
      where t.status = 'active' and n.status = 'active' and not t.is_native order by t.id`,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    networkId: Number(r.network_id),
    symbol: r.symbol,
    decimals: Number(r.decimals),
    isTestToken: r.is_test_token,
    networkCode: r.code,
    networkName: r.name,
    isSimulatedNetwork: r.family === 'simulated',
  }));
}

export interface ProfileView {
  email: string;
  displayName: string | null;
  countryCode: string | null;
  accountStatus: string;
  restrictionReason: string | null;
  kycStatus: string;
  riskDisclosureAcceptedAt: Date | null;
  riskDisclosureVersion: string | null;
}

export async function getProfile(db: Db, userId: string): Promise<ProfileView | null> {
  const r = await maybeOne<{
    email: string;
    display_name: string | null;
    country_code: string | null;
    account_status: string;
    restriction_reason: string | null;
    kyc: string | null;
    risk_disclosure_accepted_at: Date | null;
    risk_disclosure_version: string | null;
  }>(
    db,
    `select p.email, p.display_name, p.country_code, p.account_status, p.restriction_reason,
            k.status as kyc, p.risk_disclosure_accepted_at, p.risk_disclosure_version
       from public.user_profiles p left join public.user_kyc_current k on k.user_id = p.user_id
      where p.user_id = $1`,
    [userId],
  );
  if (!r) return null;
  return {
    email: r.email,
    displayName: r.display_name,
    countryCode: r.country_code,
    accountStatus: r.account_status,
    restrictionReason: r.restriction_reason,
    kycStatus: r.kyc ?? 'not_started',
    riskDisclosureAcceptedAt: r.risk_disclosure_accepted_at,
    riskDisclosureVersion: r.risk_disclosure_version,
  };
}

export interface PositionView {
  poolId: number;
  poolName: string;
  isSimulated: boolean;
  tokenId: number;
  units: bigint;
  unitsLocked: bigint;
  costBasis: bigint;
  navpu: bigint | null;
  navAsOf: Date | null;
  value: bigint | null;
  unrealized: bigint | null;
  realized: bigint;
  latestValuationFailed: boolean;
}

export async function getPositions(db: Db, userId: string): Promise<PositionView[]> {
  const rows = await many<{
    pool_id: number;
    name: string;
    is_simulated: boolean;
    token_id: number;
    units: string;
    units_locked: string;
    cost_basis_base: string;
    navpu: string | null;
    valued_at: Date | null;
    last_status: string | null;
    realized: string;
  }>(
    db,
    `select p.pool_id, ip.name, ip.is_simulated, ip.token_id, p.units::text, p.units_locked::text, p.cost_basis_base::text,
            v.navpu::text, v.valued_at, lv.status::text as last_status,
            coalesce((select sum(realized_pnl_base) from public.investment_orders o
                       where o.user_id = p.user_id and o.pool_id = p.pool_id and o.kind = 'redemption' and o.status = 'executed'), 0)::text as realized
       from public.investment_positions p
       join public.investment_pools ip on ip.id = p.pool_id
       left join lateral (select navpu, valued_at from public.portfolio_valuations
                           where pool_id = p.pool_id and status = 'final' order by valued_at desc limit 1) v on true
       left join lateral (select status from public.portfolio_valuations where pool_id = p.pool_id order by valued_at desc limit 1) lv on true
      where p.user_id = $1`,
    [userId],
  );
  return rows.map((r) => {
    const units = parseFixed(r.units);
    const navpu = r.navpu ? parseFixed(r.navpu) : null;
    const value = navpu !== null ? unitsValue(units, navpu) : null;
    const costBasis = parseBase(r.cost_basis_base);
    return {
      poolId: Number(r.pool_id),
      poolName: r.name,
      isSimulated: r.is_simulated,
      tokenId: Number(r.token_id),
      units,
      unitsLocked: parseFixed(r.units_locked),
      costBasis,
      navpu,
      navAsOf: r.valued_at,
      value,
      unrealized: value !== null ? value - costBasis : null,
      realized: parseBase(r.realized),
      latestValuationFailed: r.last_status === 'failed',
    };
  });
}

export interface PerformanceWindow {
  pnl: bigint;
  realized: bigint;
  unrealized: bigint;
  fees: bigint;
  periods: number;
}

async function windowSum(db: Db, userId: string, interval: string): Promise<PerformanceWindow> {
  const r = await maybeOne<{ pnl: string; realized: string; unrealized: string; fees: string; n: number }>(
    db,
    `select coalesce(sum(a.pnl_base), 0)::text as pnl, coalesce(sum(a.realized_share_base), 0)::text as realized,
            coalesce(sum(a.unrealized_share_base), 0)::text as unrealized, coalesce(sum(a.fees_share_base), 0)::text as fees, count(*)::int as n
       from public.performance_allocations a join public.portfolio_valuations v on v.id = a.valuation_id
      where a.user_id = $1 and v.valued_at > now() - $2::interval`,
    [userId, interval],
  );
  return { pnl: parseBase(r?.pnl), realized: parseBase(r?.realized), unrealized: parseBase(r?.unrealized), fees: parseBase(r?.fees), periods: r?.n ?? 0 };
}

export async function getPerformanceWindows(db: Db, userId: string) {
  const [day, week, month] = await Promise.all([windowSum(db, userId, '24 hours'), windowSum(db, userId, '7 days'), windowSum(db, userId, '30 days')]);
  return { day, week, month };
}

/** Pool return over the last 24h from NAV per unit (basis points, signed). */
export async function getPoolDailyReturnBps(db: Db, poolId: number): Promise<bigint | null> {
  const r = await maybeOne<{ now_navpu: string | null; then_navpu: string | null }>(
    db,
    `select (select navpu::text from public.portfolio_valuations where pool_id = $1 and status = 'final' order by valued_at desc limit 1) as now_navpu,
            (select navpu::text from public.portfolio_valuations where pool_id = $1 and status = 'final' and valued_at <= now() - interval '24 hours'
              order by valued_at desc limit 1) as then_navpu`,
    [poolId],
  );
  if (!r?.now_navpu || !r.then_navpu) return null;
  const a = parseFixed(r.now_navpu);
  const b = parseFixed(r.then_navpu);
  return b === 0n ? null : ((a - b) * 10_000n) / b;
}

export interface SeriesPoint {
  at: Date;
  value: bigint;
  pnl: bigint;
  navpu: bigint;
}

export async function getUserSeries(db: Db, userId: string, days = 90): Promise<SeriesPoint[]> {
  const rows = await many<{ valued_at: Date; units_held: string; navpu_end: string; pnl_base: string }>(
    db,
    `select v.valued_at, a.units_held::text, a.navpu_end::text, a.pnl_base::text
       from public.performance_allocations a join public.portfolio_valuations v on v.id = a.valuation_id
      where a.user_id = $1 and v.valued_at > now() - make_interval(days => $2)
      order by v.valued_at`,
    [userId, days],
  );
  return rows.map((r) => ({ at: r.valued_at, value: unitsValue(parseFixed(r.units_held), parseFixed(r.navpu_end)), pnl: parseBase(r.pnl_base), navpu: parseFixed(r.navpu_end) }));
}

export async function getPendingTotals(db: Db, userId: string) {
  const r = await maybeOne<{ dep_n: number; dep_sum: string; wd_n: number; wd_sum: string }>(
    db,
    `select (select count(*)::int from public.deposits where user_id = $1 and status in ('detected', 'confirming', 'confirmed', 'under_review')) as dep_n,
            (select coalesce(sum(amount_base), 0)::text from public.deposits where user_id = $1 and status in ('detected', 'confirming', 'confirmed', 'under_review')) as dep_sum,
            (select count(*)::int from public.withdrawal_requests where user_id = $1 and status in ('pending_verification', 'reserved', 'processing', 'broadcast')) as wd_n,
            (select coalesce(sum(amount_base), 0)::text from public.withdrawal_requests where user_id = $1 and status in ('reserved', 'processing', 'broadcast')) as wd_sum`,
    [userId],
  );
  return { depositsCount: r?.dep_n ?? 0, depositsAmount: parseBase(r?.dep_sum), withdrawalsCount: r?.wd_n ?? 0, withdrawalsAmount: parseBase(r?.wd_sum) };
}

/** Complete account summary derived from the ledger. */
export async function getDashboard(db: Db, userId: string) {
  const [profile, balances, positions, perf, pending, tokens] = await Promise.all([
    getProfile(db, userId),
    userBalances(db, userId),
    getPositions(db, userId),
    getPerformanceWindows(db, userId),
    getPendingTotals(db, userId),
    listActiveTokens(db),
  ]);
  const token = tokens[0] ?? null;
  const bal = balances.find((b) => b.tokenId === token?.id) ?? { cash: 0n, reserved: 0n, pendingSubscription: 0n };
  const pos = positions.find((p) => p.tokenId === token?.id) ?? null;
  const dailyReturnBps = pos ? await getPoolDailyReturnBps(db, pos.poolId) : null;
  const principal = (pos?.costBasis ?? 0n) + bal.pendingSubscription;
  const investmentValue = pos?.value ?? 0n;
  return {
    profile,
    token,
    available: bal.cash,
    reserved: bal.reserved,
    pendingSubscription: bal.pendingSubscription,
    principal,
    investmentValue,
    totalAccountValue: bal.cash + bal.reserved + bal.pendingSubscription + investmentValue,
    realized: pos?.realized ?? 0n,
    unrealized: pos?.unrealized ?? 0n,
    position: pos,
    performance: perf,
    dailyReturnBps,
    pending,
    isSimulated: Boolean(pos?.isSimulated || token?.isSimulatedNetwork),
  };
}

export interface ActivityItem {
  entryId: string;
  postedAt: Date;
  eventType: string;
  description: string;
  sourceType: string;
  sourceId: string;
  cashDelta: bigint;
  reservedDelta: bigint;
  pendingDelta: bigint;
}

/** The customer's ledger activity: every journal entry touching their accounts. */
export async function listActivity(db: Db, userId: string, limit = 50, before?: string): Promise<ActivityItem[]> {
  const rows = await many<{
    id: string;
    posted_at: Date;
    event_type: string;
    description: string;
    source_type: string;
    source_id: string;
    cash: string;
    reserved: string;
    pending: string;
  }>(
    db,
    `select e.id, e.posted_at, e.event_type, e.description, e.source_type, e.source_id,
            sum(case when a.purpose = 'user_cash' then (case when l.direction = 'C' then l.amount else -l.amount end) else 0 end)::text as cash,
            sum(case when a.purpose = 'user_reserved' then (case when l.direction = 'C' then l.amount else -l.amount end) else 0 end)::text as reserved,
            sum(case when a.purpose = 'user_pending_subscription' then (case when l.direction = 'C' then l.amount else -l.amount end) else 0 end)::text as pending
       from public.journal_lines l
       join public.ledger_accounts a on a.id = l.account_id
       join public.journal_entries e on e.id = l.entry_id
      where a.user_id = $1 and ($3::bigint is null or e.id < $3)
      group by e.id
      order by e.id desc
      limit $2`,
    [userId, Math.min(limit, 200), before ?? null],
  );
  return rows.map((r) => ({
    entryId: r.id,
    postedAt: r.posted_at,
    eventType: r.event_type,
    description: r.description,
    sourceType: r.source_type,
    sourceId: r.source_id,
    cashDelta: parseBase(r.cash),
    reservedDelta: parseBase(r.reserved),
    pendingDelta: parseBase(r.pending),
  }));
}

export async function listDeposits(db: Db, userId: string, limit = 50) {
  const rows = await many<{
    id: string;
    status: string;
    status_reason: string | null;
    amount_base: string;
    confirmations: number;
    required_confirmations: number;
    detected_at: Date;
    credited_at: Date | null;
    tx_hash: string;
    network: string;
    symbol: string | null;
    decimals: number | null;
    explorer_tx_url: string | null;
    is_simulated: boolean;
  }>(
    db,
    `select d.id, d.status, d.status_reason, d.amount_base::text, d.confirmations, d.required_confirmations, d.detected_at, d.credited_at,
            c.tx_hash, n.name as network, t.symbol, t.decimals, n.explorer_tx_url, c.is_simulated
       from public.deposits d join public.chain_transactions c on c.id = d.chain_transaction_id
       join public.supported_networks n on n.id = d.network_id left join public.supported_tokens t on t.id = d.token_id
      where d.user_id = $1 order by d.detected_at desc limit $2`,
    [userId, limit],
  );
  return rows.map((r) => ({ ...r, amount: parseBase(r.amount_base), decimals: r.decimals ?? 6 }));
}

export async function listWithdrawals(db: Db, userId: string, limit = 50) {
  const rows = await many<{
    id: string;
    status: string;
    status_reason: string | null;
    amount_base: string;
    fee_base: string;
    net_amount_base: string;
    destination_address: string;
    created_at: Date;
    requires_manual_review: boolean;
    network: string;
    symbol: string;
    decimals: number;
    tx_hash: string | null;
    confirmations: number | null;
    explorer_tx_url: string | null;
    is_simulated: boolean;
  }>(
    db,
    `select w.id, w.status, w.status_reason, w.amount_base::text, w.fee_base::text, w.net_amount_base::text, w.destination_address, w.created_at,
            w.requires_manual_review, n.name as network, t.symbol, t.decimals, tx.tx_hash, tx.confirmations, n.explorer_tx_url, w.is_simulated
       from public.withdrawal_requests w
       join public.supported_networks n on n.id = w.network_id join public.supported_tokens t on t.id = w.token_id
       left join lateral (select tx_hash, confirmations from public.withdrawal_transactions where withdrawal_id = w.id order by attempt desc limit 1) tx on true
      where w.user_id = $1 order by w.created_at desc limit $2`,
    [userId, limit],
  );
  return rows.map((r) => ({ ...r, amount: parseBase(r.amount_base), fee: parseBase(r.fee_base), net: parseBase(r.net_amount_base) }));
}

export async function listOrders(db: Db, userId: string, limit = 50) {
  const rows = await many<{
    id: string;
    kind: string;
    status: string;
    amount_base: string | null;
    units: string | null;
    navpu: string | null;
    requested_at: Date;
    executed_at: Date | null;
    realized_pnl_base: string | null;
    pool: string;
    is_simulated: boolean;
  }>(
    db,
    `select o.id, o.kind, o.status, o.amount_base::text, o.units::text, o.navpu::text, o.requested_at, o.executed_at, o.realized_pnl_base::text,
            p.name as pool, p.is_simulated
       from public.investment_orders o join public.investment_pools p on p.id = o.pool_id
      where o.user_id = $1 order by o.requested_at desc limit $2`,
    [userId, limit],
  );
  return rows.map((r) => ({
    ...r,
    amount: r.amount_base ? parseBase(r.amount_base) : null,
    unitsFixed: r.units ? parseFixed(r.units) : null,
    navpuFixed: r.navpu ? parseFixed(r.navpu) : null,
    realized: r.realized_pnl_base ? parseBase(r.realized_pnl_base) : null,
  }));
}

export async function listAllocations(db: Db, userId: string, limit = 60) {
  const rows = await many<{ valued_at: Date; pnl_base: string; realized_share_base: string; unrealized_share_base: string; fees_share_base: string; is_simulated: boolean; period_key: string }>(
    db,
    `select v.valued_at, v.period_key, a.pnl_base::text, a.realized_share_base::text, a.unrealized_share_base::text, a.fees_share_base::text, a.is_simulated
       from public.performance_allocations a join public.portfolio_valuations v on v.id = a.valuation_id
      where a.user_id = $1 order by v.valued_at desc limit $2`,
    [userId, limit],
  );
  return rows.map((r) => ({
    at: r.valued_at,
    periodKey: r.period_key,
    pnl: parseBase(r.pnl_base),
    realized: parseBase(r.realized_share_base),
    unrealized: parseBase(r.unrealized_share_base),
    fees: parseBase(r.fees_share_base),
    isSimulated: r.is_simulated,
  }));
}

export async function listNotifications(db: Db, userId: string, limit = 20) {
  return many<{ id: string; kind: string; payload: Record<string, unknown>; created_at: Date; read_at: Date | null }>(
    db,
    "select id, kind, payload, created_at, read_at from public.notification_events where user_id = $1 and channel = 'in_app' order by created_at desc limit $2",
    [userId, limit],
  );
}

/**
 * Where a referred member stands. A referral qualifies once the account is
 * approved and has at least one credited deposit; rewards (if any) are decided
 * later by staff, so nothing here pays anyone.
 */
export type ReferralStage = 'awaiting_approval' | 'joined' | 'qualified' | 'inactive';

export function referralStage(accountStatus: string, firstCreditedAt: Date | null): ReferralStage {
  if (accountStatus === 'pending_approval') return 'awaiting_approval';
  if (accountStatus !== 'active') return 'inactive';
  return firstCreditedAt ? 'qualified' : 'joined';
}

/** Earliest credited deposit (automatic or assigned by an admin) of `p.user_id`. */
export const FIRST_CREDITED_AT_SQL = `(select min(d.credited_at) from public.deposits d where d.user_id = p.user_id and d.status = 'credited')`;

export interface MembershipView {
  memberCode: string;
  sponsorMemberCode: string | null;
  /** Members this user referred. Member ids only: other members' emails and amounts are never shown. */
  sponsored: { memberCode: string; joinedAt: Date; stage: ReferralStage }[];
}

export async function getMembership(db: Db, userId: string): Promise<MembershipView | null> {
  const r = await maybeOne<{ member_code: string; sponsor_code: string | null }>(
    db,
    `select p.member_code, s.member_code as sponsor_code
       from public.user_profiles p left join public.user_profiles s on s.user_id = p.sponsor_user_id
      where p.user_id = $1`,
    [userId],
  );
  if (!r) return null;
  const sponsored = await many<{ member_code: string; created_at: Date; account_status: string; first_credited_at: Date | null }>(
    db,
    `select p.member_code, p.created_at, p.account_status::text as account_status, ${FIRST_CREDITED_AT_SQL} as first_credited_at
       from public.user_profiles p where p.sponsor_user_id = $1 order by p.created_at`,
    [userId],
  );
  return {
    memberCode: r.member_code,
    sponsorMemberCode: r.sponsor_code,
    sponsored: sponsored.map((s) => ({ memberCode: s.member_code, joinedAt: s.created_at, stage: referralStage(s.account_status, s.first_credited_at) })),
  };
}

export interface ReferralRewardView {
  id: string;
  referredMemberCode: string;
  amountBase: string;
  symbol: string;
  decimals: number;
  status: 'pending' | 'approved' | 'rejected' | 'posted';
  qualifiedAt: Date;
  postedAt: Date | null;
}

/** Referral rewards earned by this user. Rejection notes are shown in notifications, not here. */
export async function listReferralRewards(db: Db, userId: string): Promise<ReferralRewardView[]> {
  const rows = await many<{
    id: string;
    member_code: string;
    amount_base: string;
    symbol: string;
    decimals: number;
    status: ReferralRewardView['status'];
    qualified_at: Date;
    posted_at: Date | null;
  }>(
    db,
    `select r.id, p.member_code, r.amount_base::text, t.symbol, t.decimals, r.status, r.qualified_at, r.posted_at
       from public.referral_rewards r
       join public.user_profiles p on p.user_id = r.referred_user_id
       join public.supported_tokens t on t.id = r.token_id
      where r.sponsor_user_id = $1 order by r.created_at desc`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    referredMemberCode: r.member_code,
    amountBase: r.amount_base,
    symbol: r.symbol,
    decimals: Number(r.decimals),
    status: r.status,
    qualifiedAt: r.qualified_at,
    postedAt: r.posted_at,
  }));
}
