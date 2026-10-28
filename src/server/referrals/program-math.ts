/**
 * Pure rules of the matching bonus and rank program, so they can be unit
 * tested without a database. Volumes are 18-decimal fixed point (see
 * reward_base_earnings.amount_fixed); reward amounts are token base units.
 */
import { mulDivDown, parseUnits } from '@/lib/money';
import type { RewardsProgram } from '../ops';

/**
 * The program as first published: provisional settings with every payout off.
 * Used for display until an administrator saves a policy version.
 */
export const DEFAULT_PROGRAM: RewardsProgram = {
  program_start: '2026-10-28T00:00:00.000Z',
  placement_mode: 'outer',
  matching: {
    enabled: false,
    tree: 'sponsor',
    levels: [500, 500, 400, 400, 400, 300, 300, 300, 200, 100].map((rate_bps, i) => ({ level: i + 1, rate_bps })),
    min_left: '50',
    min_right: '50',
    min_rank: null,
  },
  ranks: {
    rewards_enabled: false,
    token_id: null,
    levels: [
      { code: 'E1', left: '1500', right: '1500', self: '150', bonus: '50' },
      { code: 'E2', left: '9000', right: '9000', self: '500', bonus: '300' },
      { code: 'E3', left: '25000', right: '25000', self: '1000', bonus: '1500' },
      { code: 'E4', left: '55000', right: '55000', self: '2500', bonus: '4500' },
      { code: 'E5', left: '1000000', right: '1000000', self: '5000', bonus: '9000' },
      { code: 'E6', left: '2500000', right: '2500000', self: '10000', bonus: '18000' },
      { code: 'E7', left: '5000000', right: '5000000', self: '20000', bonus: '29000' },
      { code: 'Prince', left: '10000000', right: '10000000', self: '30000', bonus: '50000' },
      { code: 'King', left: '25000000', right: '25000000', self: '40000', bonus: '1000000' },
      { code: 'Emperor', left: '50000000', right: '50000000', self: '50000', bonus: '3000000' },
    ],
  },
};

export interface Volumes {
  /** Operator-funded earnings of the whole left / right team, and the member's own. 18-dp fixed. */
  left: bigint;
  right: bigint;
  self: bigint;
}

/** A dollar setting ("1500") as 18-dp fixed point. */
export const usdFixed = (usd: string): bigint => parseUnits(usd, 18);

/** Base units of a token with `decimals` as 18-dp fixed point. */
export const toFixed = (amountBase: bigint, decimals: number): bigint => amountBase * 10n ** BigInt(18 - decimals);

/** 18-dp fixed point as base units of a token, rounded down. */
export const fromFixed = (fixed: bigint, decimals: number): bigint => fixed / 10n ** BigInt(18 - decimals);

/** A matching reward: `rateBps` of the matched earning, rounded down. */
export const matchingAmount = (baseAmount: bigint, rateBps: number): bigint => mulDivDown(baseAmount, BigInt(rateBps), 10_000n);

/**
 * Ranks reached with these volumes. Ranks are a ladder: each needs the one
 * before it, and the left target, right target and own amount all at once.
 */
export function ranksMet(v: Volumes, ranks: RewardsProgram['ranks']['levels']): string[] {
  const met: string[] = [];
  for (const r of ranks) {
    if (v.left < usdFixed(r.left) || v.right < usdFixed(r.right) || v.self < usdFixed(r.self)) break;
    met.push(r.code);
  }
  return met;
}

/** 1-based position of a rank on the ladder, 0 for none or unknown. */
export const rankOrder = (code: string | null, ranks: RewardsProgram['ranks']['levels']): number => (code ? ranks.findIndex((r) => r.code === code) + 1 : 0);

export interface RankProgress {
  current: string | null;
  next: RewardsProgram['ranks']['levels'][number] | null;
  /** Share of each next-rank target reached, in basis points (capped at 10000). */
  leftBps: number;
  rightBps: number;
  selfBps: number;
}

const progressBps = (have: bigint, need: string): number => {
  const n = usdFixed(need);
  if (n === 0n) return 10_000;
  return Number(have >= n ? 10_000n : mulDivDown(have < 0n ? 0n : have, 10_000n, n));
};

/** The highest rank held (from achievements) and progress toward the next one. */
export function rankProgress(v: Volumes, highestOrder: number, ranks: RewardsProgram['ranks']['levels']): RankProgress {
  const current = highestOrder > 0 ? (ranks[highestOrder - 1]?.code ?? null) : null;
  const next = ranks[highestOrder] ?? null;
  return {
    current,
    next,
    leftBps: next ? progressBps(v.left, next.left) : 10_000,
    rightBps: next ? progressBps(v.right, next.right) : 10_000,
    selfBps: next ? progressBps(v.self, next.self) : 10_000,
  };
}

export interface MatchingEligibility {
  eligible: boolean;
  reasons: string[];
}

/** Whether a member may receive matching rewards now. Never eligible while matching is off. */
export function matchingEligibility(
  m: { active: boolean; volumes: Volumes; highestRankOrder: number },
  program: RewardsProgram,
): MatchingEligibility {
  const reasons: string[] = [];
  if (!program.matching.enabled) reasons.push('Matching payouts are not switched on');
  if (!m.active) reasons.push('Account is not active');
  if (m.volumes.left < usdFixed(program.matching.min_left)) reasons.push(`Left team below the ${program.matching.min_left} USD minimum`);
  if (m.volumes.right < usdFixed(program.matching.min_right)) reasons.push(`Right team below the ${program.matching.min_right} USD minimum`);
  const need = rankOrder(program.matching.min_rank, program.ranks.levels);
  if (need > 0 && m.highestRankOrder < need) reasons.push(`Rank ${program.matching.min_rank} not reached yet`);
  return { eligible: reasons.length === 0, reasons };
}

export interface MatchingLine {
  level: number;
  userId: string;
  rateBps: number;
  amount: bigint;
}

/**
 * Matching rewards for one earning: one line per eligible upline member per
 * level, skipping ineligible members (their level is not passed up) and
 * amounts that round to zero.
 */
export function planMatching(
  baseAmount: bigint,
  levels: RewardsProgram['matching']['levels'],
  upline: { level: number; userId: string; eligible: boolean }[],
): MatchingLine[] {
  const lines: MatchingLine[] = [];
  for (const u of upline) {
    const rate = levels.find((l) => l.level === u.level)?.rate_bps ?? 0;
    if (!u.eligible || rate === 0) continue;
    const amount = matchingAmount(baseAmount, rate);
    if (amount > 0n) lines.push({ level: u.level, userId: u.userId, rateBps: rate, amount });
  }
  return lines;
}
