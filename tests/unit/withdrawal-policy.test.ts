import { describe, expect, it } from 'vitest';
import { evaluatePayout, evaluateRequest, type PayoutContext, type RequestContext } from '../../src/server/withdrawals/policy';
import { withdrawalPolicySchema } from '../../src/server/ops';

const policy = withdrawalPolicySchema.parse({
  require_kyc_approved: true,
  require_mfa: true,
  fee_base: '1000000',
  max_per_tx_base: '10000000000',
  user_daily_limit_base: '20000000000',
  global_daily_limit_base: '200000000000',
  max_requests_per_hour: 3,
  manual_review_above_base: '5000000000',
  new_destination_cooldown_minutes: 2,
  new_destination_manual_review_above_base: '1000000000',
  hot_wallet_min_reserve_base: '0',
  block_on_reconciliation_discrepancy: true,
});

const req = (o: Partial<RequestContext> = {}): RequestContext => ({
  policy,
  amount: 20_000000n,
  tokenMinWithdrawal: 10_000000n,
  networkActive: true,
  withdrawalsPaused: false,
  accountStatus: 'active',
  kycStatus: 'approved',
  addressValid: true,
  destinationIsDepositAddress: false,
  userDailyTotal: 0n,
  globalDailyTotal: 0n,
  requestsLastHour: 0,
  ...o,
});

const now = new Date('2026-10-17T12:00:00Z');
const payout = (o: Partial<PayoutContext> = {}): PayoutContext => ({
  policy,
  amount: 20_000000n,
  net: 19_000000n,
  now,
  withdrawalsPaused: false,
  accountStatus: 'active',
  kycStatus: 'approved',
  complianceHold: false,
  manuallyApproved: false,
  reconciliationOk: true,
  destination: { usableAfter: new Date(now.getTime() - 1000), isNew: false },
  screening: { provider: 'mock', isSimulated: true, risk: 'low', reasons: [] },
  hotWalletAvailable: 100_000_000000n,
  ...o,
});

describe('withdrawal request policy', () => {
  it('computes fee and net amount', () => {
    const d = evaluateRequest(req());
    expect(d.allowed).toBe(true);
    expect(d.fee).toBe(1_000000n);
    expect(d.net).toBe(19_000000n);
  });

  it.each([
    ['paused', { withdrawalsPaused: true }, 'withdrawals_enabled'],
    ['below minimum', { amount: 9_999999n }, 'min_amount'],
    ['over per-tx max', { amount: 10_000_000001n }, 'max_per_tx'],
    ['daily limit', { userDailyTotal: 19_990_000000n }, 'user_daily_limit'],
    ['velocity', { requestsLastHour: 3 }, 'velocity'],
    ['kyc', { kycStatus: 'pending' }, 'kyc_approved'],
    ['frozen account', { accountStatus: 'frozen' }, 'account_active'],
    ['invalid address', { addressValid: false }, 'address_valid'],
    ['own deposit address', { destinationIsDepositAddress: true }, 'not_platform_deposit_address'],
  ] as const)('rejects when %s', (_label, override, check) => {
    const d = evaluateRequest(req(override as Partial<RequestContext>));
    expect(d.allowed).toBe(false);
    expect(d.checks.find((c) => c.name === check)?.result).toBe('fail');
  });
});

describe('payout policy', () => {
  it('approves a clean payout', () => expect(evaluatePayout(payout()).decision).toBe('approve'));
  it('holds during an emergency pause', () => expect(evaluatePayout(payout({ withdrawalsPaused: true })).decision).toBe('hold'));
  it('holds after a reconciliation discrepancy', () => expect(evaluatePayout(payout({ reconciliationOk: false })).decision).toBe('hold'));
  it('holds without liquidity', () => expect(evaluatePayout(payout({ hotWalletAvailable: 1n })).decision).toBe('hold'));
  it('holds when balances or screening are unavailable', () => {
    expect(evaluatePayout(payout({ hotWalletAvailable: null })).decision).toBe('hold');
    expect(evaluatePayout(payout({ screening: null })).decision).toBe('hold');
  });
  it('holds a new destination during its cooldown and reports when to retry', () => {
    const usableAfter = new Date(now.getTime() + 60_000);
    const r = evaluatePayout(payout({ destination: { usableAfter, isNew: true } }));
    expect(r.decision).toBe('hold');
    expect(r.retryAfter).toEqual(usableAfter);
  });
  it('sends large amounts to manual review; approval clears review but not holds', () => {
    expect(evaluatePayout(payout({ amount: 6_000_000000n, net: 5_999_000000n })).decision).toBe('manual_review');
    expect(evaluatePayout(payout({ amount: 6_000_000000n, net: 5_999_000000n, manuallyApproved: true })).decision).toBe('approve');
    expect(evaluatePayout(payout({ amount: 6_000_000000n, manuallyApproved: true, withdrawalsPaused: true })).decision).toBe('hold');
  });
  it('holds restricted accounts and lapsed KYC even when manually approved; rejects frozen accounts', () => {
    expect(evaluatePayout(payout({ accountStatus: 'restricted', manuallyApproved: true })).decision).toBe('hold');
    expect(evaluatePayout(payout({ kycStatus: 'expired', manuallyApproved: true })).decision).toBe('hold');
    expect(evaluatePayout(payout({ accountStatus: 'frozen', manuallyApproved: true })).decision).toBe('reject');
  });
  it('holds compliance-held withdrawals', () => expect(evaluatePayout(payout({ complianceHold: true, manuallyApproved: true })).decision).toBe('hold'));
  it('rejects severe-risk destinations even if manually approved', () => {
    const r = evaluatePayout(payout({ screening: { provider: 'mock', isSimulated: true, risk: 'severe', reasons: ['sanctioned'] }, manuallyApproved: true }));
    expect(r.decision).toBe('reject');
  });
});
