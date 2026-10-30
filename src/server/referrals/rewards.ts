/**
 * Operator-funded referral rewards.
 *
 * Accounting
 *   fund   (allocation 'referral_fund', worker):  D suspense_deposits     C referral_reward_fund
 *   reward (worker, after admin approval):        D referral_reward_fund  C user_cash (sponsor)
 *
 * The fund holds only operator money the group wallet actually received, and
 * may never go negative (enforced by the ledger), so rewards can never exceed
 * funding or touch members' deposits.
 *
 * Lifecycle: pending (recorded by the worker when a referral qualifies) →
 * approved or rejected (administrator, documented note) → posted (worker).
 * Only posted rewards are on the ledger, so nothing pending or approved can be
 * withdrawn. One reward per referred member, ever (unique in the database).
 */
import { many, maybeOne, one, type Db } from '../db-core';
import { mulDivDown, parseBase, parseUnits } from '@/lib/money';
import { ensureAccount, lockBalance, postEntry, transfer } from '../ledger/ledger';
import { getToken } from '../chains/registry';
import { currentPolicy, isControlEnabled, isSoleAdmin, notify, raiseRiskEvent, recordAudit, type Actor, type ReferralPolicy, type VersionedPolicy } from '../ops';

export class ReferralRewardError extends Error {
  override name = 'ReferralRewardError';
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

const MIN_NOTE = 10;

/** Recognition tiers used until an administrator saves a referral policy. */
export const DEFAULT_TIERS: ReferralPolicy['tiers'] = [
  { label: 'EW1', min_qualified: 1 },
  { label: 'EW2', min_qualified: 3 },
  { label: 'EW3', min_qualified: 5 },
  { label: 'EW4', min_qualified: 10 },
  { label: 'EW5', min_qualified: 25 },
  { label: 'EW6', min_qualified: 50 },
  { label: 'EW7', min_qualified: 100 },
];

export interface TierProgress {
  current: ReferralPolicy['tiers'][number] | null;
  next: ReferralPolicy['tiers'][number] | null;
  /** Qualified referrals still needed for the next tier (0 at the top). */
  remaining: number;
}

/** The highest tier reached with `qualified` referrals, and what the next one needs. Tiers are sorted ascending. */
export function referralTier(qualified: number, tiers: ReferralPolicy['tiers']): TierProgress {
  let current: TierProgress['current'] = null;
  for (const t of tiers) if (qualified >= t.min_qualified) current = t;
  const next = tiers.find((t) => t.min_qualified > qualified) ?? null;
  return { current, next, remaining: next ? next.min_qualified - qualified : 0 };
}

/**
 * The reward for one qualified referral, in token base units: a share of the
 * referred member's first credited deposit when the policy sets reward_bps
 * (rounded down), otherwise the fixed reward_amount.
 */
export function referralRewardAmount(params: Pick<ReferralPolicy, 'reward_amount' | 'reward_bps'>, firstDepositBase: bigint, decimals: number): bigint {
  if (params.reward_bps !== undefined) return mulDivDown(firstDepositBase, BigInt(params.reward_bps), 10_000n);
  return parseUnits(params.reward_amount, decimals);
}

/** A short description of the reward, e.g. "5% of their first deposit" or "10 USDT". */
export function describeReferralReward(params: Pick<ReferralPolicy, 'reward_amount' | 'reward_bps'>): string {
  return params.reward_bps !== undefined ? `${params.reward_bps / 100}% of their first deposit` : `${params.reward_amount} USDT`;
}

/** The current referral policy, or null if none was ever saved (the program is then off). */
export async function referralPolicy(db: Db): Promise<VersionedPolicy<ReferralPolicy> | null> {
  const exists = await maybeOne(db, "select 1 from public.policy_versions where kind = 'referral' and effective_from <= now() limit 1");
  return exists ? currentPolicy(db, 'referral') : null;
}

/** Save a new referral policy version. Policies are never edited in place. */
export async function saveReferralPolicy(db: Db, actor: Actor, params: ReferralPolicy, note: string): Promise<{ version: number }> {
  if (note.trim().length < MIN_NOTE) throw new ReferralRewardError(`A note of at least ${MIN_NOTE} characters is required`, 'note_required');
  if (params.reward_bps === undefined && parseUnits(params.reward_amount, 18) <= 0n && params.enabled) throw new ReferralRewardError('The reward amount must be positive', 'invalid_amount');
  // Serialize concurrent saves so version numbers stay unique and gapless.
  await db.query("select pg_advisory_xact_lock(hashtext('policy:referral'))");
  const previous = await referralPolicy(db);
  const row = await one<{ version: number }>(
    db,
    `insert into public.policy_versions (kind, version, params, change_note, created_by, approved_by)
     values ('referral', coalesce((select max(version) from public.policy_versions where kind = 'referral'), 0) + 1, $1::jsonb, $2, $3, $3)
     returning version`,
    [JSON.stringify(params), note.trim(), `${actor.type}:${actor.id}`],
  );
  const details = { version: row.version, previous: previous?.params ?? null, next: params, note: note.trim() };
  await recordAudit(db, actor, 'referral.policy_saved', { type: 'policy', id: `referral:${row.version}` }, details);
  // Changes what the operator pays out, so it is alerted like other admin money decisions.
  await raiseRiskEvent(db, { kind: 'referral_policy_changed', severity: 'high', subjectType: 'policy', subjectId: `referral:${row.version}`, details });
  return row;
}

/**
 * Worker: record a pending reward for every referral that qualified under the
 * current policy and has none yet. Idempotent: one row per referred member
 * (`on conflict do nothing`), and the amount is fixed when the row is written.
 */
export async function detectReferralRewards(db: Db): Promise<number> {
  const policy = await referralPolicy(db);
  if (!policy?.params.enabled) return 0;
  const candidates = await many<{ referred: string; sponsor: string; token_id: number; credited_at: Date; amount_base: string }>(
    db,
    `select p.user_id as referred, p.sponsor_user_id as sponsor, d.token_id, d.credited_at, d.amount_base::text as amount_base
       from public.user_profiles p
       join public.user_profiles s on s.user_id = p.sponsor_user_id
       cross join lateral (
         select token_id, credited_at, amount_base from public.deposits
          where user_id = p.user_id and status = 'credited' and token_id is not null
          order by credited_at, id limit 1
       ) d
      where p.account_status = 'active' and s.account_status = 'active'
        and p.created_at >= $1::timestamptz
        and p.user_id <> p.sponsor_user_id
        and not exists (select 1 from public.referral_rewards r where r.referred_user_id = p.user_id)
      order by d.credited_at limit 200`,
    [policy.params.program_start],
  );
  let created = 0;
  for (const c of candidates) {
    const token = await getToken(db, Number(c.token_id));
    const amount = referralRewardAmount(policy.params, parseBase(c.amount_base), token.decimals);
    if (amount <= 0n) continue;
    const res = await db.query(
      `insert into public.referral_rewards (referred_user_id, sponsor_user_id, token_id, amount_base, policy_version_id, qualified_at)
       values ($1, $2, $3, $4, $5, $6) on conflict (referred_user_id) do nothing`,
      [c.referred, c.sponsor, token.id, amount.toString(), policy.id, c.credited_at],
    );
    if (res.rowCount === 1) {
      created += 1;
      await notify(db, { audience: 'operations', kind: 'referral_reward_pending', payload: { sponsorUserId: c.sponsor, amountBase: amount.toString() }, dedupeKey: `referral_reward_pending:${c.referred}` });
    }
  }
  return created;
}

/**
 * Administrator decision on a pending reward. A staff member may not decide a
 * reward paid to themselves, except a sole administrator, which is alerted.
 */
export async function reviewReferralReward(
  db: Db,
  args: { rewardId: string; decision: 'approve' | 'reject'; note: string; staffUserId: string; actor: Actor },
): Promise<void> {
  const note = args.note.trim();
  if (note.length < MIN_NOTE) throw new ReferralRewardError(`A note of at least ${MIN_NOTE} characters is required`, 'note_required');
  const r = await maybeOne<{ id: string; sponsor_user_id: string; referred_user_id: string; amount_base: string; token_id: number; status: string }>(
    db,
    'select id, sponsor_user_id, referred_user_id, amount_base::text, token_id, status from public.referral_rewards where id = $1 for update',
    [args.rewardId],
  );
  if (!r) throw new ReferralRewardError('Referral reward not found', 'not_found');
  if (r.status !== 'pending') throw new ReferralRewardError(`This reward is already ${r.status}`, 'invalid_state');
  const toSelf = r.sponsor_user_id === args.staffUserId || r.referred_user_id === args.staffUserId;
  if (toSelf && !(await isSoleAdmin(db, args.staffUserId))) {
    throw new ReferralRewardError('Staff cannot review a referral reward they are part of', 'conflict_of_interest');
  }
  const status = args.decision === 'approve' ? 'approved' : 'rejected';
  await db.query('update public.referral_rewards set status = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4 where id = $1', [
    r.id,
    status,
    args.staffUserId,
    note,
  ]);
  const details = { sponsorUserId: r.sponsor_user_id, referredUserId: r.referred_user_id, amountBase: r.amount_base, tokenId: Number(r.token_id), note, toSelf };
  await recordAudit(db, args.actor, `referral.reward_${status}`, { type: 'referral_reward', id: r.id }, details);
  if (status === 'approved' || toSelf) {
    await raiseRiskEvent(db, {
      userId: r.sponsor_user_id,
      kind: toSelf ? 'admin_self_referral_reward' : 'referral_reward_approved',
      severity: 'high',
      subjectType: 'referral_reward',
      subjectId: r.id,
      details,
    });
  }
  if (status === 'rejected') {
    await notify(db, { userId: r.sponsor_user_id, kind: 'referral_reward_rejected', payload: { rewardId: r.id, reason: note }, dedupeKey: `referral_reward:${r.id}:rejected` });
  }
}

export type RewardPostOutcome = 'posted' | 'deferred' | 'unchanged';

/**
 * Worker: pay an approved reward from the fund. Holds (deferred, with a recorded
 * reason) when the fund is short, the sponsor is no longer active, or
 * allocations are paused. Idempotent via the ledger key and the status check.
 */
export async function postReferralReward(db: Db, rewardId: string, actor: Actor): Promise<RewardPostOutcome> {
  const r = await maybeOne<{ id: string; sponsor_user_id: string; amount_base: string; token_id: number; status: string; error: string | null }>(
    db,
    'select id, sponsor_user_id, amount_base::text, token_id, status, error from public.referral_rewards where id = $1 for update',
    [rewardId],
  );
  if (!r || r.status !== 'approved') return 'unchanged';
  const hold = async (reason: string): Promise<RewardPostOutcome> => {
    if (r.error !== reason) {
      await db.query('update public.referral_rewards set error = $2 where id = $1', [r.id, reason]);
      await raiseRiskEvent(db, { kind: 'referral_reward_held', severity: 'medium', subjectType: 'referral_reward', subjectId: r.id, details: { reason } });
    }
    return 'deferred';
  };
  if (await isControlEnabled(db, 'allocations_paused')) return 'deferred';
  // Paid only once the referrer has claimed it.
  if (!(await one<{ c: boolean }>(db, `select ${CLAIMED_SQL('r')} is not null as c from public.referral_rewards r where r.id = $1`, [r.id])).c) return 'deferred';
  const sponsor = await one<{ account_status: string }>(db, 'select account_status from public.user_profiles where user_id = $1', [r.sponsor_user_id]);
  if (sponsor.account_status !== 'active') return hold(`sponsor account is ${sponsor.account_status}`);

  const tokenId = Number(r.token_id);
  const amount = parseBase(r.amount_base);
  const fund = await ensureAccount(db, 'referral_reward_fund', tokenId);
  if ((await lockBalance(db, fund)) < amount) return hold('referral reward fund is too low; top it up from the group wallet');

  const cash = await ensureAccount(db, 'user_cash', tokenId, { userId: r.sponsor_user_id });
  const entryId = await postEntry(db, {
    idempotencyKey: `referral_reward:${r.id}`,
    eventType: 'referral_reward',
    sourceType: 'referral_reward',
    sourceId: r.id,
    description: 'Referral reward',
    postedBy: `${actor.type}:${actor.id}`,
    lines: transfer(fund, cash, amount),
  });
  await db.query("update public.referral_rewards set status = 'posted', entry_id = $2, posted_at = now(), error = null where id = $1", [r.id, entryId]);
  await notify(db, { userId: r.sponsor_user_id, kind: 'referral_reward_paid', payload: { rewardId: r.id, amountBase: r.amount_base }, dedupeKey: `referral_reward:${r.id}:paid` });
  await recordAudit(db, actor, 'referral.reward_posted', { type: 'referral_reward', id: r.id }, { entryId });
  return 'posted';
}

export async function listApprovedReferralRewardIds(db: Db): Promise<string[]> {
  return (await many<{ id: string }>(db, `select r.id from public.referral_rewards r where r.status = 'approved' and ${CLAIMED_SQL('r')} is not null order by r.reviewed_at limit 100`)).map((r) => r.id);
}


/** Read through jsonb so this works before the claims migration is applied. */
const CLAIMED_SQL = (alias: string) => `(to_jsonb(${alias}) ->> 'claimed_at')`;

/**
 * The referrer claims their recorded commission. Rewards are shown first and
 * paid only after the owner claims them (and an administrator approves).
 * Claiming twice is harmless; only the owner can claim, and only an open reward.
 */
export async function claimReferralReward(db: Db, args: { userId: string; rewardId: string; actor: Actor }): Promise<void> {
  const r = await maybeOne<{ id: string; status: string; claimed: string | null; amount_base: string }>(
    db,
    `select r.id, r.status, ${CLAIMED_SQL('r')} as claimed, r.amount_base::text from public.referral_rewards r where r.id = $1 and r.sponsor_user_id = $2 for update`,
    [args.rewardId, args.userId],
  );
  if (!r) throw new ReferralRewardError('Reward not found', 'not_found');
  if (r.claimed) return;
  if (r.status !== 'pending' && r.status !== 'approved') throw new ReferralRewardError(`This reward is ${r.status} and cannot be claimed`, 'not_claimable');
  await db.query('update public.referral_rewards set claimed_at = now() where id = $1', [r.id]);
  await recordAudit(db, args.actor, 'referral_reward.claimed', { type: 'referral_reward', id: r.id }, { amountBase: r.amount_base });
  await notify(db, { audience: 'operations', kind: 'reward_claimed', payload: { rewardId: r.id, kind: 'referral' }, dedupeKey: `reward_claimed:referral:${r.id}` });
}

export type RecordedRewardStatus = 'pending' | 'approved' | 'rejected' | 'posted' | 'cancelled';
/**
 * Where a referral's commission stands, for the member's own view:
 * a recorded reward's status, or 'earned' (qualified under the current policy,
 * not yet recorded by the worker), 'no_deposit', 'not_eligible' (joined before
 * the program start, or an account is not active) or 'program_off'.
 */
export type CommissionStatus = RecordedRewardStatus | 'earned' | 'no_deposit' | 'not_eligible' | 'program_off';

/** Pure: the status of one referral's commission (mirrors detectReferralRewards). */
export function commissionStatus(args: {
  recorded: RecordedRewardStatus | null;
  hasDeposit: boolean;
  programOn: boolean;
  joinedAt: Date;
  programStart: string | null;
  referredActive: boolean;
  sponsorActive: boolean;
}): CommissionStatus {
  if (args.recorded) return args.recorded;
  if (!args.programOn || !args.programStart) return 'program_off';
  if (!args.hasDeposit) return 'no_deposit';
  if (!args.referredActive || !args.sponsorActive || args.joinedAt < new Date(args.programStart)) return 'not_eligible';
  return 'earned';
}

export interface CommissionView {
  memberCode: string;
  joinedAt: Date;
  firstDeposit: { amountBase: string; decimals: number; symbol: string; creditedAt: Date } | null;
  /** The recorded reward, or what the current policy pays for it; null when nothing is due. */
  commissionBase: bigint | null;
  decimals: number;
  symbol: string;
  status: CommissionStatus;
  postedAt: Date | null;
  /** The recorded reward, so the referrer can claim it. */
  rewardId: string | null;
  claimedAt: string | null;
}

/**
 * Every member `sponsorId` referred, with their first credited deposit and the
 * commission it earns, shown as soon as it is earned (before the worker
 * records it), so the referrer can follow it through approval to payment.
 */
export async function referralCommissions(db: Db, sponsorId: string): Promise<CommissionView[]> {
  const policy = await referralPolicy(db);
  const program = policy?.params.enabled ? policy.params : null;
  const rows = await many<{
    member_code: string;
    created_at: Date;
    referred_status: string;
    sponsor_status: string;
    dep_amount: string | null;
    dep_decimals: number | null;
    dep_symbol: string | null;
    credited_at: Date | null;
    r_status: RecordedRewardStatus | null;
    r_amount: string | null;
    r_decimals: number | null;
    r_symbol: string | null;
    posted_at: Date | null;
    r_id: string | null;
    claimed_at: string | null;
  }>(
    db,
    `select p.member_code, p.created_at, p.account_status::text as referred_status, s.account_status::text as sponsor_status,
            d.amount_base::text as dep_amount, dt.decimals as dep_decimals, dt.symbol as dep_symbol, d.credited_at,
            r.status::text as r_status, r.amount_base::text as r_amount, rt.decimals as r_decimals, rt.symbol as r_symbol, r.posted_at,
            r.id as r_id, ${CLAIMED_SQL('r')} as claimed_at
       from public.user_profiles p
       join public.user_profiles s on s.user_id = p.sponsor_user_id
       left join lateral (
         select token_id, amount_base, credited_at from public.deposits
          where user_id = p.user_id and status = 'credited' and token_id is not null
          order by credited_at, id limit 1
       ) d on true
       left join public.supported_tokens dt on dt.id = d.token_id
       left join public.referral_rewards r on r.referred_user_id = p.user_id
       left join public.supported_tokens rt on rt.id = r.token_id
      where p.sponsor_user_id = $1 and p.user_id <> $1
      order by p.created_at desc`,
    [sponsorId],
  );
  return rows.map((r) => {
    const firstDeposit =
      r.dep_amount !== null && r.dep_decimals !== null
        ? { amountBase: r.dep_amount, decimals: Number(r.dep_decimals), symbol: r.dep_symbol ?? 'USDT', creditedAt: r.credited_at! }
        : null;
    const status = commissionStatus({
      recorded: r.r_status,
      hasDeposit: firstDeposit !== null,
      programOn: program !== null,
      joinedAt: new Date(r.created_at),
      programStart: program?.program_start ?? null,
      referredActive: r.referred_status === 'active',
      sponsorActive: r.sponsor_status === 'active',
    });
    if (r.r_amount !== null) {
      return {
        memberCode: r.member_code,
        joinedAt: r.created_at,
        firstDeposit,
        commissionBase: parseBase(r.r_amount),
        decimals: Number(r.r_decimals),
        symbol: r.r_symbol ?? 'USDT',
        status,
        postedAt: r.posted_at,
        rewardId: r.r_id,
        claimedAt: r.claimed_at,
      };
    }
    const due = status === 'earned' && program && firstDeposit ? referralRewardAmount(program, parseBase(firstDeposit.amountBase), firstDeposit.decimals) : null;
    return {
      memberCode: r.member_code,
      joinedAt: r.created_at,
      firstDeposit,
      commissionBase: due,
      decimals: firstDeposit?.decimals ?? 18,
      symbol: firstDeposit?.symbol ?? 'USDT',
      status,
      postedAt: null,
      rewardId: null,
      claimedAt: null,
    };
  });
}
