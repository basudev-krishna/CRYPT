import { describe, expect, it } from 'vitest';
import { DEFAULT_TIERS, referralTier } from '../../src/server/referrals/rewards';
import { referralPolicySchema } from '../../src/server/ops';
import { validateSplit } from '../../src/server/deposits/allocations';

describe('referralTier', () => {
  it('uses EW labels and reports progress to the next tier', () => {
    expect(DEFAULT_TIERS.map((t) => t.label)).toEqual(['EW1', 'EW2', 'EW3', 'EW4', 'EW5', 'EW6', 'EW7']);
    expect(referralTier(0, DEFAULT_TIERS)).toEqual({ current: null, next: DEFAULT_TIERS[0], remaining: 1 });
    expect(referralTier(4, DEFAULT_TIERS)).toMatchObject({ current: { label: 'EW2' }, next: { label: 'EW3' }, remaining: 1 });
    expect(referralTier(500, DEFAULT_TIERS)).toMatchObject({ current: { label: 'EW7' }, next: null, remaining: 0 });
  });
});

describe('referral policy', () => {
  const valid = { enabled: true, reward_amount: '10', program_start: '2026-10-27T00:00:00.000Z', tiers: DEFAULT_TIERS };
  it('accepts a valid policy', () => {
    expect(referralPolicySchema.parse(valid)).toMatchObject({ reward_amount: '10' });
  });
  it('rejects bad amounts and tiers', () => {
    for (const reward_amount of ['-1', '1e3', '1.1234567', '', 'ten']) expect(referralPolicySchema.safeParse({ ...valid, reward_amount }).success).toBe(false);
    expect(referralPolicySchema.safeParse({ ...valid, tiers: [{ label: 'EW1', min_qualified: 3 }, { label: 'EW2', min_qualified: 3 }] }).success).toBe(false);
    expect(referralPolicySchema.safeParse({ ...valid, tiers: [{ label: 'EW1', min_qualified: 1 }, { label: 'EW1', min_qualified: 2 }] }).success).toBe(false);
  });
});

describe('referral fund top-up split', () => {
  it('takes the whole receipt and no member lines', () => {
    expect(validateSplit('referral_fund', 100n, [])).toBeNull();
    expect(validateSplit('referral_fund', 100n, [{ userId: 'a', amount: 100n }])).not.toBeNull();
  });
});
