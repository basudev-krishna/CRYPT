/**
 * Withdrawal policy engine (pure). Two evaluation points:
 *
 *   evaluateRequest  - at request/confirmation time, before funds are reserved.
 *                      Any failure rejects the request outright.
 *   evaluatePayout   - in the worker, after reservation, immediately before
 *                      sending to custody. Outcomes: approve | hold (retry later)
 *                      | manual_review | reject (reservation released).
 *
 * Every check is reported so the decision is explainable in the admin UI and
 * stored with the request (risk_result) together with the policy version.
 */
import type { WithdrawalPolicy } from '../ops';
import type { ScreeningResult } from '../compliance/compliance';

export type CheckResult = 'pass' | 'fail' | 'hold' | 'review';
export interface PolicyCheck {
  name: string;
  result: CheckResult;
  detail?: string;
}

export interface RequestContext {
  policy: WithdrawalPolicy;
  amount: bigint;
  tokenMinWithdrawal: bigint;
  networkActive: boolean;
  withdrawalsPaused: boolean;
  accountStatus: string | null;
  kycStatus: string;
  addressValid: boolean;
  destinationIsDepositAddress: boolean;
  userDailyTotal: bigint;
  globalDailyTotal: bigint;
  requestsLastHour: number;
}

export interface RequestDecision {
  allowed: boolean;
  checks: PolicyCheck[];
  fee: bigint;
  net: bigint;
}

const fmt = (v: bigint) => v.toString();

export function evaluateRequest(c: RequestContext): RequestDecision {
  const p = c.policy;
  const fee = p.fee_base;
  const net = c.amount - fee;
  const checks: PolicyCheck[] = [
    { name: 'withdrawals_enabled', result: c.withdrawalsPaused ? 'fail' : 'pass', detail: c.withdrawalsPaused ? 'Withdrawals are paused' : undefined },
    { name: 'network_active', result: c.networkActive ? 'pass' : 'fail' },
    { name: 'account_active', result: c.accountStatus === 'active' ? 'pass' : 'fail', detail: `status=${c.accountStatus}` },
    { name: 'kyc_approved', result: !p.require_kyc_approved || c.kycStatus === 'approved' ? 'pass' : 'fail', detail: `kyc=${c.kycStatus}` },
    { name: 'address_valid', result: c.addressValid ? 'pass' : 'fail' },
    {
      name: 'not_platform_deposit_address',
      result: c.destinationIsDepositAddress ? 'fail' : 'pass',
      detail: c.destinationIsDepositAddress ? 'Destination is a platform deposit address' : undefined,
    },
    { name: 'min_amount', result: c.amount >= c.tokenMinWithdrawal ? 'pass' : 'fail', detail: `min=${fmt(c.tokenMinWithdrawal)}` },
    { name: 'covers_fee', result: net > 0n ? 'pass' : 'fail', detail: `fee=${fmt(fee)}` },
    { name: 'max_per_tx', result: c.amount <= p.max_per_tx_base ? 'pass' : 'fail', detail: `max=${fmt(p.max_per_tx_base)}` },
    {
      name: 'user_daily_limit',
      result: c.userDailyTotal + c.amount <= p.user_daily_limit_base ? 'pass' : 'fail',
      detail: `used=${fmt(c.userDailyTotal)} limit=${fmt(p.user_daily_limit_base)}`,
    },
    {
      name: 'global_daily_limit',
      result: c.globalDailyTotal + c.amount <= p.global_daily_limit_base ? 'pass' : 'fail',
    },
    {
      name: 'velocity',
      result: c.requestsLastHour < p.max_requests_per_hour ? 'pass' : 'fail',
      detail: `${c.requestsLastHour} in last hour, max ${p.max_requests_per_hour}`,
    },
  ];
  return { allowed: checks.every((x) => x.result === 'pass'), checks, fee, net };
}

export interface PayoutContext {
  policy: WithdrawalPolicy;
  amount: bigint;
  net: bigint;
  now: Date;
  withdrawalsPaused: boolean;
  accountStatus: string | null;
  kycStatus: string;
  complianceHold: boolean;
  manuallyApproved: boolean;
  reconciliationOk: boolean | null; // null = no completed run yet; false = discrepancy, error or stale
  destination: { usableAfter: Date; isNew: boolean };
  screening: ScreeningResult | null; // null = screening unavailable
  hotWalletAvailable: bigint | null; // null = balance unavailable
}

export type PayoutDecision = 'approve' | 'hold' | 'manual_review' | 'reject';

export function evaluatePayout(c: PayoutContext): { decision: PayoutDecision; checks: PolicyCheck[]; retryAfter?: Date } {
  const p = c.policy;
  const checks: PolicyCheck[] = [];
  const add = (name: string, result: CheckResult, detail?: string) => checks.push({ name, result, detail });

  add('withdrawals_enabled', c.withdrawalsPaused ? 'hold' : 'pass');
  // A restricted account is held (never cleared by a manual approval); frozen/closed rejects.
  add('account_active', c.accountStatus === 'active' ? 'pass' : c.accountStatus === 'frozen' || c.accountStatus === 'closed' ? 'fail' : 'hold', `status=${c.accountStatus}`);
  if (p.require_kyc_approved) add('kyc_approved', c.kycStatus === 'approved' ? 'pass' : 'hold', `kyc=${c.kycStatus}`);
  add('compliance_hold', c.complianceHold ? 'hold' : 'pass');
  if (p.block_on_reconciliation_discrepancy) {
    add('reconciliation_clean', c.reconciliationOk === false ? 'hold' : 'pass', c.reconciliationOk === null ? 'no run yet' : undefined);
  }

  if (!c.screening) add('destination_screening', 'hold', 'screening unavailable');
  else if (c.screening.risk === 'severe') add('destination_screening', 'fail', c.screening.reasons.join('; '));
  else if (c.screening.risk === 'high') add('destination_screening', 'review', c.screening.reasons.join('; '));
  else add('destination_screening', 'pass');

  const cooling = c.destination.usableAfter.getTime() > c.now.getTime();
  add('destination_cooldown', cooling ? 'hold' : 'pass', cooling ? `usable after ${c.destination.usableAfter.toISOString()}` : undefined);
  if (c.destination.isNew && c.amount > p.new_destination_manual_review_above_base) {
    add('new_destination_large_amount', 'review');
  }
  add('manual_review_threshold', c.amount > p.manual_review_above_base ? 'review' : 'pass');

  if (c.hotWalletAvailable === null) add('liquidity', 'hold', 'hot wallet balance unavailable');
  else add('liquidity', c.hotWalletAvailable - c.net >= p.hot_wallet_min_reserve_base ? 'pass' : 'hold', `available=${c.hotWalletAvailable}`);

  // Manual approval clears "review" checks but never overrides fail/hold.
  const effective = checks.map((x) => (x.result === 'review' && c.manuallyApproved ? 'pass' : x.result));
  let decision: PayoutDecision = 'approve';
  if (effective.includes('fail')) decision = 'reject';
  else if (effective.includes('hold')) decision = 'hold';
  else if (effective.includes('review')) decision = 'manual_review';

  return {
    decision,
    checks,
    ...(decision === 'hold' && cooling ? { retryAfter: c.destination.usableAfter } : {}),
  };
}
