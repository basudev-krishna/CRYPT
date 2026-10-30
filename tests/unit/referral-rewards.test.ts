import { describe, expect, it } from 'vitest';
import { DEFAULT_TIERS, commissionStatus, describeReferralReward, referralRewardAmount, referralTier } from '../../src/server/referrals/rewards';
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

describe('referral reward amount', () => {
  const usdt18 = (v: bigint) => v * 10n ** 18n;
  it('pays a share of the first deposit when a percentage is set, rounded down', () => {
    expect(referralRewardAmount({ reward_amount: '0', reward_bps: 500 }, usdt18(200n), 18)).toBe(usdt18(10n)); // 5% of 200
    expect(referralRewardAmount({ reward_amount: '0', reward_bps: 500 }, 999n, 6)).toBe(49n); // 49.95 -> 49 base units
    expect(referralRewardAmount({ reward_amount: '0', reward_bps: 500 }, 0n, 18)).toBe(0n);
  });
  it('pays the fixed amount when no percentage is set', () => {
    expect(referralRewardAmount({ reward_amount: '10' }, usdt18(5000n), 18)).toBe(usdt18(10n));
    expect(referralRewardAmount({ reward_amount: '2.5' }, 1n, 6)).toBe(2_500_000n);
  });
  it('describes the reward for members', () => {
    expect(describeReferralReward({ reward_amount: '0', reward_bps: 500 })).toBe('5% of their first deposit');
    expect(describeReferralReward({ reward_amount: '10' })).toBe('10 USDT');
  });
});

describe('commission status for the referrer', () => {
  const base = {
    recorded: null,
    hasDeposit: true,
    programOn: true,
    joinedAt: new Date('2026-10-29T10:00:00Z'),
    programStart: '2026-10-29T00:00:00.000Z',
    referredActive: true,
    sponsorActive: true,
  } as const;
  it('shows a commission as earned as soon as the first deposit is credited', () => {
    expect(commissionStatus(base)).toBe('earned');
  });
  it('follows the recorded reward once the worker has recorded it', () => {
    expect(commissionStatus({ ...base, recorded: 'approved' })).toBe('approved');
    expect(commissionStatus({ ...base, recorded: 'posted', programOn: false })).toBe('posted');
  });
  it('explains why nothing is due', () => {
    expect(commissionStatus({ ...base, hasDeposit: false })).toBe('no_deposit');
    expect(commissionStatus({ ...base, programOn: false })).toBe('program_off');
    expect(commissionStatus({ ...base, joinedAt: new Date('2026-10-01T00:00:00Z') })).toBe('not_eligible');
    expect(commissionStatus({ ...base, sponsorActive: false })).toBe('not_eligible');
  });
});
