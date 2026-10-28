import { describe, expect, it } from 'vitest';
import { rewardsProgramSchema } from '../../src/server/ops';
import { DEFAULT_PROGRAM, fromFixed, matchingAmount, matchingEligibility, planMatching, rankOrder, rankProgress, ranksMet, toFixed, usdFixed } from '../../src/server/referrals/program-math';

const usd = usdFixed;
const on = { ...DEFAULT_PROGRAM, matching: { ...DEFAULT_PROGRAM.matching, enabled: true } };

describe('rewards program defaults', () => {
  it('are a valid policy with every payout off', () => {
    expect(rewardsProgramSchema.parse(DEFAULT_PROGRAM)).toEqual(DEFAULT_PROGRAM);
    expect(DEFAULT_PROGRAM.matching.enabled).toBe(false);
    expect(DEFAULT_PROGRAM.ranks.rewards_enabled).toBe(false);
  });

  it('carry the published 10-level schedule (34% in total) and 10 ranks', () => {
    expect(DEFAULT_PROGRAM.matching.levels.map((l) => l.rate_bps / 100)).toEqual([5, 5, 4, 4, 4, 3, 3, 3, 2, 1]);
    expect(DEFAULT_PROGRAM.ranks.levels.map((r) => r.code)).toEqual(['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'Prince', 'King', 'Emperor']);
  });

  it('refuse rates over 100%, gaps in levels, unknown minimum ranks and rank rewards without a token', () => {
    const bad = [
      { matching: { ...DEFAULT_PROGRAM.matching, levels: [{ level: 1, rate_bps: 6000 }, { level: 2, rate_bps: 5000 }] } },
      { matching: { ...DEFAULT_PROGRAM.matching, levels: [{ level: 2, rate_bps: 500 }] } },
      { matching: { ...DEFAULT_PROGRAM.matching, min_rank: 'E99' } },
      { ranks: { ...DEFAULT_PROGRAM.ranks, rewards_enabled: true, token_id: null } },
    ];
    for (const b of bad) expect(rewardsProgramSchema.safeParse({ ...DEFAULT_PROGRAM, ...b }).success).toBe(false);
  });
});

describe('amounts', () => {
  it('converts between token base units and 18-dp fixed point exactly, rounding down', () => {
    expect(toFixed(1_500_000n, 6)).toBe(usd('1.5'));
    expect(fromFixed(usd('1.5'), 6)).toBe(1_500_000n);
    expect(fromFixed(usd('0.0000009'), 6)).toBe(0n);
  });

  it('matches a share of the base, rounded down', () => {
    expect(matchingAmount(100_000_000n, 500)).toBe(5_000_000n);
    expect(matchingAmount(3n, 500)).toBe(0n);
  });
});

describe('ranks', () => {
  const ranks = DEFAULT_PROGRAM.ranks.levels;
  it('needs the left target, right target and own amount together, in ladder order', () => {
    expect(ranksMet({ left: usd('1500'), right: usd('1500'), self: usd('150') }, ranks)).toEqual(['E1']);
    expect(ranksMet({ left: usd('1500'), right: usd('1499.99'), self: usd('150') }, ranks)).toEqual([]);
    expect(ranksMet({ left: usd('9000'), right: usd('9000'), self: usd('149') }, ranks)).toEqual([]);
    expect(ranksMet({ left: usd('30000'), right: usd('30000'), self: usd('1000') }, ranks)).toEqual(['E1', 'E2', 'E3']);
  });

  it('reports progress toward the next rank', () => {
    const p = rankProgress({ left: usd('750'), right: usd('1500'), self: 0n }, 0, ranks);
    expect(p).toMatchObject({ current: null, leftBps: 5000, rightBps: 10_000, selfBps: 0 });
    expect(p.next?.code).toBe('E1');
    expect(rankProgress({ left: 0n, right: 0n, self: 0n }, 10, ranks)).toMatchObject({ current: 'Emperor', next: null });
    expect(rankOrder('E3', ranks)).toBe(3);
    expect(rankOrder(null, ranks)).toBe(0);
  });
});

describe('matching', () => {
  const strong = { active: true, volumes: { left: usd('50'), right: usd('50'), self: 0n }, highestRankOrder: 0 };

  it('is never eligible while matching is off', () => {
    expect(matchingEligibility(strong, DEFAULT_PROGRAM)).toEqual({ eligible: false, reasons: ['Matching payouts are not switched on'] });
  });

  it('needs an active account, both side minimums and the minimum rank', () => {
    expect(matchingEligibility(strong, on).eligible).toBe(true);
    expect(matchingEligibility({ ...strong, active: false }, on).eligible).toBe(false);
    expect(matchingEligibility({ ...strong, volumes: { ...strong.volumes, right: usd('49.99') } }, on).reasons).toEqual(['Right team below the 50 USD minimum']);
    const ranked = { ...on, matching: { ...on.matching, min_rank: 'E1' } };
    expect(matchingEligibility(strong, ranked).eligible).toBe(false);
    expect(matchingEligibility({ ...strong, highestRankOrder: 1 }, ranked).eligible).toBe(true);
  });

  it('pays each eligible level its own rate and skips ineligible members without passing their share up', () => {
    const lines = planMatching(100_000_000n, on.matching.levels, [
      { level: 1, userId: 'a', eligible: true },
      { level: 2, userId: 'b', eligible: false },
      { level: 3, userId: 'c', eligible: true },
    ]);
    expect(lines).toEqual([
      { level: 1, userId: 'a', rateBps: 500, amount: 5_000_000n },
      { level: 3, userId: 'c', rateBps: 400, amount: 4_000_000n },
    ]);
  });
});
