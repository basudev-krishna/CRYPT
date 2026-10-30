/**
 * Cross-cutting operational records: audit log, risk events, notifications,
 * emergency controls and versioned policies.
 */
import { z } from 'zod';
import { maybeOne, one, type Db } from './db-core';

export type ActorType = 'user' | 'staff' | 'service' | 'system';
export interface Actor {
  type: ActorType;
  id: string;
  ip?: string | null;
  userAgent?: string | null;
}

export const actorRef = (a: Actor) => `${a.type}:${a.id}`;
export const serviceActor = (name: string): Actor => ({ type: 'service', id: name });

export async function recordAudit(
  db: Db,
  actor: Actor,
  action: string,
  subject?: { type: string; id: string },
  details: Record<string, unknown> = {},
): Promise<void> {
  await db.query(
    `insert into public.audit_events (actor_type, actor_id, action, subject_type, subject_id, ip, user_agent, details)
     values ($1, $2, $3, $4, $5, $6::inet, $7, $8::jsonb)`,
    [actor.type, actor.id, action, subject?.type ?? null, subject?.id ?? null, actor.ip ?? null, actor.userAgent ?? null, JSON.stringify(details, bigintReplacer)],
  );
}

export type RiskSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export async function raiseRiskEvent(
  db: Db,
  e: { userId?: string | null; kind: string; severity: RiskSeverity; subjectType: string; subjectId: string; details?: Record<string, unknown> },
): Promise<string> {
  const row = await one<{ id: string }>(
    db,
    `insert into public.risk_events (user_id, kind, severity, subject_type, subject_id, details)
     values ($1, $2, $3, $4, $5, $6::jsonb) returning id`,
    [e.userId ?? null, e.kind, e.severity, e.subjectType, e.subjectId, JSON.stringify(e.details ?? {}, bigintReplacer)],
  );
  return row.id;
}

export async function notify(
  db: Db,
  n: { userId?: string | null; audience?: 'user' | 'operations'; kind: string; channel?: 'email' | 'in_app'; payload?: Record<string, unknown>; dedupeKey?: string },
): Promise<void> {
  await db.query(
    `insert into public.notification_events (user_id, audience, kind, channel, payload, dedupe_key)
     values ($1, $2, $3, $4, $5::jsonb, $6) on conflict (dedupe_key) do nothing`,
    [n.userId ?? null, n.audience ?? 'user', n.kind, n.channel ?? 'in_app', JSON.stringify(n.payload ?? {}, bigintReplacer), n.dedupeKey ?? null],
  );
}

export type ControlKey = 'withdrawals_paused' | 'deposits_paused' | 'allocations_paused' | 'return_accruals_paused' | 'return_settlements_paused';

export async function isControlEnabled(db: Db, key: ControlKey): Promise<boolean> {
  const row = await maybeOne<{ enabled: boolean }>(db, 'select enabled from public.system_controls where key = $1', [key]);
  return row?.enabled ?? true; // fail closed if the row is missing
}

export async function setControl(db: Db, key: ControlKey, enabled: boolean, reason: string, actor: Actor): Promise<void> {
  await db.query(
    'update public.system_controls set enabled = $2, reason = $3, updated_by = $4, updated_at = now() where key = $1',
    [key, enabled, reason, actorRef(actor)],
  );
  await recordAudit(db, actor, enabled ? `control.enable.${key}` : `control.disable.${key}`, { type: 'system_control', id: key }, { reason });
  if (enabled) {
    await notify(db, { audience: 'operations', kind: 'control_enabled', payload: { key, reason } });
  }
}

// -----------------------------------------------------------------------------
// Policies (schemas double as documentation of each policy's parameters)
// -----------------------------------------------------------------------------
const baseStr = z.string().regex(/^\d+$/).transform((v) => BigInt(v));

export const withdrawalPolicySchema = z.object({
  require_kyc_approved: z.boolean(),
  require_mfa: z.boolean(),
  fee_base: baseStr,
  max_per_tx_base: baseStr,
  user_daily_limit_base: baseStr,
  global_daily_limit_base: baseStr,
  max_requests_per_hour: z.number().int().positive(),
  manual_review_above_base: baseStr,
  new_destination_cooldown_minutes: z.number().int().min(0),
  new_destination_manual_review_above_base: baseStr,
  hot_wallet_min_reserve_base: baseStr,
  block_on_reconciliation_discrepancy: z.boolean(),
});
export type WithdrawalPolicy = z.infer<typeof withdrawalPolicySchema>;

export const depositPolicySchema = z.object({
  require_kyc_approved: z.boolean(),
  below_minimum: z.enum(['hold_in_suspense']),
  manual_review_above_base: baseStr,
  auto_subscribe: z.boolean(),
});
export type DepositPolicy = z.infer<typeof depositPolicySchema>;

export const feePolicySchema = z.object({
  management_fee_bps_per_year: z.number().int().min(0).max(1000),
  performance_fee_bps: z.number().int().min(0).max(5000),
  high_water_mark: z.boolean(),
});
export type FeePolicy = z.infer<typeof feePolicySchema>;

export const allocationPolicySchema = z.object({
  method: z.literal('unitized_forward_pricing'),
  rounding: z.literal('down_in_favour_of_pool'),
  valuation_frequency: z.enum(['daily', 'hourly']),
});
export type AllocationPolicy = z.infer<typeof allocationPolicySchema>;

/**
 * Operator-funded referral rewards. `reward_amount` is in whole tokens (e.g.
 * "10" = 10 USDT), converted with the token's decimals when a reward is
 * recorded. Only referrals of members who joined at or after `program_start`
 * earn one. Tiers are recognition labels by qualified-referral count; they
 * carry no money.
 */
export const referralPolicySchema = z.object({
  enabled: z.boolean(),
  // At most 6 decimals, so the amount fits every supported stablecoin.
  reward_amount: z.string().regex(/^\d{1,12}(\.\d{1,6})?$/, 'Use at most 6 decimal places'),
  /**
   * When set, the reward is this share (basis points, 500 = 5%) of the referred
   * member's first credited deposit instead of the fixed reward_amount. Still
   * one reward per referred member, paid from the operator's referral fund.
   */
  reward_bps: z.number().int().min(1).max(10_000).optional(),
  program_start: z.iso.datetime({ offset: true }),
  tiers: z
    .array(z.object({ label: z.string().regex(/^[A-Za-z0-9 ]{1,16}$/), min_qualified: z.number().int().positive() }))
    .max(20)
    .refine((t) => t.every((x, i) => i === 0 || x.min_qualified > t[i - 1]!.min_qualified), 'Tier thresholds must increase')
    .refine((t) => new Set(t.map((x) => x.label)).size === t.length, 'Tier labels must be unique'),
});
export type ReferralPolicy = z.infer<typeof referralPolicySchema>;

/** Whole US dollars with at most 6 decimals, e.g. "1500" or "0.5". */
const usdAmount = z.string().regex(/^\d{1,12}(\.\d{1,6})?$/, 'Use at most 6 decimal places');

/**
 * Matching bonus, rank rewards and sign-up team placement. Every amount is
 * measured in operator-funded earnings only (see reward_base_earnings): never
 * deposits. Matching and rank payouts are each off until switched on, apply
 * only from `program_start`, and every reward still needs an administrator's
 * approval against the funded reward pool.
 */
export const rewardsProgramSchema = z
  .object({
    program_start: z.iso.datetime({ offset: true }),
    /** When the chosen side under the sponsor is taken: refuse ('direct') or go down that side's outer edge ('outer'). */
    placement_mode: z.enum(['direct', 'outer']),
    matching: z.object({
      enabled: z.boolean(),
      /** Whose earnings a member matches: their sponsor line or their placement (team) line. */
      tree: z.enum(['sponsor', 'placement']),
      levels: z
        .array(z.object({ level: z.number().int().min(1).max(10), rate_bps: z.number().int().min(0).max(10_000) }))
        .min(1)
        .max(10)
        .refine((l) => l.every((x, i) => x.level === i + 1), 'Levels must be numbered 1, 2, 3… in order')
        .refine((l) => l.reduce((s, x) => s + x.rate_bps, 0) <= 10_000, 'All levels together may not exceed 100%'),
      min_left: usdAmount,
      min_right: usdAmount,
      /** Rank a member must have reached before matching pays them; null for none. */
      min_rank: z.string().nullable(),
    }),
    ranks: z.object({
      rewards_enabled: z.boolean(),
      /** Token rank bonuses are paid in; required to switch rank rewards on. */
      token_id: z.number().int().positive().nullable(),
      levels: z
        .array(z.object({ code: z.string().regex(/^[A-Za-z0-9]{1,12}$/), left: usdAmount, right: usdAmount, self: usdAmount, bonus: usdAmount }))
        .min(1)
        .max(20)
        .refine((l) => new Set(l.map((x) => x.code)).size === l.length, 'Rank codes must be unique'),
    }),
  })
  .refine((p) => p.matching.min_rank === null || p.ranks.levels.some((r) => r.code === p.matching.min_rank), {
    message: 'The minimum rank for matching must be one of the ranks',
    path: ['matching', 'min_rank'],
  })
  .refine((p) => !p.ranks.rewards_enabled || p.ranks.token_id !== null, { message: 'Choose the token rank rewards are paid in', path: ['ranks', 'token_id'] });
export type RewardsProgram = z.infer<typeof rewardsProgramSchema>;

const schemas = {
  withdrawal: withdrawalPolicySchema,
  deposit: depositPolicySchema,
  fee: feePolicySchema,
  allocation: allocationPolicySchema,
  referral: referralPolicySchema,
  rewards_program: rewardsProgramSchema,
} as const;
export type PolicyKind = keyof typeof schemas;

export interface VersionedPolicy<T> {
  id: string;
  version: number;
  params: T;
}

export async function currentPolicy<K extends PolicyKind>(db: Db, kind: K): Promise<VersionedPolicy<z.infer<(typeof schemas)[K]>>> {
  const row = await maybeOne<{ id: string; version: number; params: unknown }>(
    db,
    `select id, version, params from public.policy_versions
      where kind = $1 and effective_from <= now() order by effective_from desc, version desc limit 1`,
    [kind],
  );
  if (!row) throw new Error(`No active ${kind} policy`);
  const params = schemas[kind].parse(row.params) as z.infer<(typeof schemas)[K]>;
  return { id: row.id, version: row.version, params };
}

/** JSON.stringify replacer that serializes bigint as string. */
export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/**
 * True when `userId` is the only administrator. Four-eyes rules cannot be met
 * then, so they fall back to a self-review that is always alerted. Adding a
 * second administrator restores the stricter rule automatically.
 */
export async function isSoleAdmin(db: Db, userId: string): Promise<boolean> {
  const r = await one<{ n: number; me: boolean | null }>(
    db,
    "select count(*)::int as n, bool_or(user_id = $1) as me from public.staff_roles where role = 'admin'",
    [userId],
  );
  return r.n === 1 && r.me === true;
}
