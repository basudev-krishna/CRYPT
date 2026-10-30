/**
 * Matching bonus and rank rewards, funded only by the operator.
 *
 * What counts. Every volume and matching base is an operator-funded earning:
 * a ledger entry between the referral reward fund and a member's cash
 * (referral rewards, administrator bonuses for work, and their reversals; see
 * the reward_base_earnings view). Deposits never touch the fund, so a member's
 * deposit can never earn anyone a reward. Matching and rank rewards are not
 * earnings for this purpose, so rewards never feed further rewards.
 *
 * Accounting (worker, after administrator approval):
 *   D referral_reward_fund  C user_cash (beneficiary)
 * The fund may never go negative, and approval first checks that the fund
 * covers the reward on top of everything already approved.
 *
 * Lifecycle: pending (recorded by the worker) → approved or rejected
 * (administrator, documented note) → posted (worker); the worker cancels a
 * matching reward whose source earning was reversed before it was paid. Only
 * posted rewards are on the ledger, so nothing earlier can be withdrawn.
 */
import { many, maybeOne, one, type Db } from '../db-core';
import { parseBase } from '@/lib/money';
import { ensureAccount, lockBalance, postEntry, transfer } from '../ledger/ledger';
import { getToken } from '../chains/registry';
import { currentPolicy, isControlEnabled, isSoleAdmin, notify, raiseRiskEvent, recordAudit, type Actor, type RewardsProgram, type VersionedPolicy } from '../ops';
import { DEFAULT_PROGRAM, fromFixed, matchingEligibility, planMatching, rankOrder, ranksMet, usdFixed, type Volumes } from './program-math';
import type { Side } from './network';

export class ProgramRewardError extends Error {
  override name = 'ProgramRewardError';
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

const MIN_NOTE = 10;
const MAX_LEVELS = 10;

/**
 * SQL: the earning in entry `$ref` was undone, by a ledger reversal or by a
 * reversing manual adjustment (the usual way a bonus is corrected).
 */
const reversedSql = (ref: string) => `(exists (select 1 from public.journal_entries x where x.reverses_entry_id = ${ref})
  or exists (select 1 from public.manual_adjustments m join public.manual_adjustments rv on rv.reverses_adjustment_id = m.id
              where m.entry_id = ${ref} and rv.status in ('pending', 'posted')))`;

/** The saved program policy, or null if none was ever saved (every payout is then off). */
export async function programPolicy(db: Db): Promise<VersionedPolicy<RewardsProgram> | null> {
  const exists = await maybeOne(db, "select 1 from public.policy_versions where kind = 'rewards_program' and effective_from <= now() limit 1");
  return exists ? currentPolicy(db, 'rewards_program') : null;
}

/** The program to display and enforce: the saved policy, or the provisional defaults (payouts off). */
export async function effectiveProgram(db: Db): Promise<{ params: RewardsProgram; version: number | null }> {
  const p = await programPolicy(db);
  return p ? { params: p.params, version: p.version } : { params: DEFAULT_PROGRAM, version: null };
}

/** Save a new program policy version. Policies are never edited in place; every save is audited and alerted. */
export async function saveProgramPolicy(db: Db, actor: Actor, params: RewardsProgram, note: string): Promise<{ version: number }> {
  if (note.trim().length < MIN_NOTE) throw new ProgramRewardError(`A note of at least ${MIN_NOTE} characters is required`, 'note_required');
  if (params.ranks.token_id !== null) await getToken(db, params.ranks.token_id);
  await db.query("select pg_advisory_xact_lock(hashtext('policy:rewards_program'))");
  const previous = await programPolicy(db);
  const row = await one<{ version: number }>(
    db,
    `insert into public.policy_versions (kind, version, params, change_note, created_by, approved_by)
     values ('rewards_program', coalesce((select max(version) from public.policy_versions where kind = 'rewards_program'), 0) + 1, $1::jsonb, $2, $3, $3)
     returning version`,
    [JSON.stringify(params), note.trim(), `${actor.type}:${actor.id}`],
  );
  const details = { version: row.version, previous: previous?.params ?? null, next: params, note: note.trim() };
  await recordAudit(db, actor, 'rewards_program.policy_saved', { type: 'policy', id: `rewards_program:${row.version}` }, details);
  await raiseRiskEvent(db, { kind: 'rewards_program_changed', severity: 'high', subjectType: 'policy', subjectId: `rewards_program:${row.version}`, details });
  return row;
}

// -----------------------------------------------------------------------------
// Volumes
// -----------------------------------------------------------------------------
export interface MemberVolumes extends Volumes {
  leftCount: number;
  rightCount: number;
}

/**
 * Operator-funded earnings of each member's whole left and right team and of
 * the member themselves (18-dp fixed), for `userIds` or everyone (null).
 * Volumes are lifetime totals: nothing resets or expires.
 */
export async function memberVolumes(db: Db, userIds: string[] | null): Promise<Map<string, MemberVolumes>> {
  const rows = await many<{ user_id: string; left_v: string; right_v: string; self_v: string; left_n: number; right_n: number }>(
    db,
    `with recursive closure(anc, side, node) as (
       select b.parent_user_id, b.side, b.user_id from public.binary_placements b
        where $1::uuid[] is null or b.parent_user_id = any($1::uuid[])
       union all
       select c.anc, c.side, b.user_id from closure c join public.binary_placements b on b.parent_user_id = c.node
     ),
     earn as (select user_id, sum(amount_fixed) as amt from public.reward_base_earnings group by user_id),
     legs as (
       select c.anc,
              sum(coalesce(e.amt, 0)) filter (where c.side = 'left') as l, sum(coalesce(e.amt, 0)) filter (where c.side = 'right') as r,
              count(*) filter (where c.side = 'left') as ln, count(*) filter (where c.side = 'right') as rn
         from closure c left join earn e on e.user_id = c.node group by c.anc
     )
     select p.user_id, coalesce(legs.l, 0)::text as left_v, coalesce(legs.r, 0)::text as right_v, coalesce(e.amt, 0)::text as self_v,
            coalesce(legs.ln, 0)::int as left_n, coalesce(legs.rn, 0)::int as right_n
       from public.user_profiles p left join legs on legs.anc = p.user_id left join earn e on e.user_id = p.user_id
      where $1::uuid[] is null or p.user_id = any($1::uuid[])`,
    [userIds],
  );
  return new Map(
    rows.map((r) => [
      r.user_id,
      { left: parseBase(r.left_v), right: parseBase(r.right_v), self: parseBase(r.self_v), leftCount: Number(r.left_n), rightCount: Number(r.right_n) },
    ]),
  );
}

/** Highest rank order held per member (0 for none), after administrator corrections. */
async function highestRanks(db: Db, userIds: string[] | null, ranks: RewardsProgram['ranks']['levels']): Promise<Map<string, number>> {
  const rows = await many<{ user_id: string; rank_code: string }>(
    db,
    'select user_id, rank_code from public.member_ranks where $1::uuid[] is null or user_id = any($1::uuid[])',
    [userIds],
  );
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.user_id, Math.max(map.get(r.user_id) ?? 0, rankOrder(r.rank_code, ranks)));
  return map;
}

// -----------------------------------------------------------------------------
// Worker: detection
// -----------------------------------------------------------------------------
/** Upline of `userId`, level 1 first, through the sponsor or the placement line. */
async function upline(db: Db, userId: string, tree: RewardsProgram['matching']['tree'], depth: number) {
  const link =
    tree === 'sponsor'
      ? { table: 'public.user_profiles', parent: 'sponsor_user_id' }
      : { table: 'public.binary_placements', parent: 'parent_user_id' };
  return many<{ level: number; user_id: string }>(
    db,
    `with recursive up(level, user_id) as (
       select 1, x.${link.parent} from ${link.table} x where x.user_id = $1 and x.${link.parent} is not null
       union all
       select up.level + 1, x.${link.parent} from up join ${link.table} x on x.user_id = up.user_id
        where x.${link.parent} is not null and up.level < $2
     ) select level, user_id from up order by level`,
    [userId, depth],
  );
}

/**
 * Record matching rewards for operator-funded earnings posted since the
 * program start. Each earning is processed once (matching_sources) under the
 * policy current then; members who are not eligible at that moment get
 * nothing for it. Idempotent: unique per earning and level.
 */
export async function detectMatchingRewards(db: Db): Promise<number> {
  const policy = await programPolicy(db);
  if (!policy?.params.matching.enabled) return 0;
  const program = policy.params;
  const sources = await many<{ entry_id: string; user_id: string; token_id: number; amount_base: string }>(
    db,
    `select r.entry_id, r.user_id, r.token_id, r.amount_base::text from public.reward_base_earnings r
      where r.amount_base > 0 and r.posted_at >= $1::timestamptz
        and not exists (select 1 from public.matching_sources s where s.entry_id = r.entry_id)
        and not ${reversedSql('r.entry_id')}
      order by r.entry_id limit 200`,
    [program.program_start],
  );
  let created = 0;
  for (const s of sources) {
    const up = await upline(db, s.user_id, program.matching.tree, Math.min(program.matching.levels.length, MAX_LEVELS));
    const ids = up.map((u) => u.user_id);
    const [vols, ranks, statuses] = await Promise.all([
      memberVolumes(db, ids),
      highestRanks(db, ids, program.ranks.levels),
      many<{ user_id: string; account_status: string }>(db, 'select user_id, account_status::text from public.user_profiles where user_id = any($1::uuid[])', [ids]),
    ]);
    const active = new Set(statuses.filter((x) => x.account_status === 'active').map((x) => x.user_id));
    const lines = planMatching(
      parseBase(s.amount_base),
      program.matching.levels,
      up.map((u) => ({
        level: u.level,
        userId: u.user_id,
        eligible: matchingEligibility(
          { active: active.has(u.user_id), volumes: vols.get(u.user_id) ?? { left: 0n, right: 0n, self: 0n }, highestRankOrder: ranks.get(u.user_id) ?? 0 },
          program,
        ).eligible,
      })),
    );
    let n = 0;
    for (const l of lines) {
      const res = await db.query(
        `insert into public.program_rewards (kind, beneficiary_user_id, token_id, amount_base, policy_version_id, source_entry_id, source_user_id, level, rate_bps, base_amount)
         values ('matching', $1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict do nothing`,
        [l.userId, s.token_id, l.amount.toString(), policy.id, s.entry_id, s.user_id, l.level, l.rateBps, s.amount_base],
      );
      n += res.rowCount ?? 0;
    }
    await db.query('insert into public.matching_sources (entry_id, policy_version_id, rewards_created) values ($1, $2, $3) on conflict do nothing', [s.entry_id, policy.id, n]);
    created += n;
  }
  if (created > 0) await notify(db, { audience: 'operations', kind: 'program_rewards_pending', payload: { count: created }, dedupeKey: `program_rewards_pending:matching:${sources.at(-1)?.entry_id}` });
  return created;
}

/**
 * Record newly reached ranks for active members, and a pending rank reward
 * for each when rank rewards are on. Ranks are permanent; a rank reached while
 * rewards were off is not paid later. Idempotent: one row per member and rank.
 */
export async function evaluateRanks(db: Db): Promise<{ ranks: number; rewards: number }> {
  const policy = await programPolicy(db);
  if (!policy) return { ranks: 0, rewards: 0 };
  const program = policy.params;
  const [vols, held, active] = await Promise.all([
    memberVolumes(db, null),
    // A rank an administrator corrected (revoked or granted) is settled: never re-reached or rewarded automatically.
    many<{ user_id: string; rank_code: string }>(db, 'select user_id, rank_code from public.rank_achievements union select user_id, rank_code from public.rank_corrections'),
    many<{ user_id: string }>(db, "select user_id from public.user_profiles where account_status = 'active'"),
  ]);
  const have = new Set(held.map((h) => `${h.user_id}:${h.rank_code}`));
  const payRewards = program.ranks.rewards_enabled && program.ranks.token_id !== null && new Date(program.program_start) <= new Date();
  const token = payRewards ? await getToken(db, program.ranks.token_id!) : null;
  let ranks = 0;
  let rewards = 0;
  for (const { user_id } of active) {
    const v = vols.get(user_id);
    if (!v) continue;
    for (const code of ranksMet(v, program.ranks.levels)) {
      if (have.has(`${user_id}:${code}`)) continue;
      const res = await db.query(
        `insert into public.rank_achievements (user_id, rank_code, rank_order, policy_version_id, left_volume, right_volume, self_volume)
         values ($1, $2, $3, $4, $5, $6, $7) on conflict do nothing`,
        [user_id, code, rankOrder(code, program.ranks.levels), policy.id, v.left.toString(), v.right.toString(), v.self.toString()],
      );
      if (res.rowCount !== 1) continue;
      ranks += 1;
      await notify(db, { userId: user_id, kind: 'rank_achieved', payload: { rank: code }, dedupeKey: `rank:${user_id}:${code}` });
      const bonus = token ? fromFixed(usdFixed(program.ranks.levels.find((r) => r.code === code)!.bonus), token.decimals) : 0n;
      if (token && bonus > 0n) {
        const r = await db.query(
          `insert into public.program_rewards (kind, beneficiary_user_id, token_id, amount_base, policy_version_id, rank_code)
           values ('rank', $1, $2, $3, $4, $5) on conflict do nothing`,
          [user_id, token.id, bonus.toString(), policy.id, code],
        );
        rewards += r.rowCount ?? 0;
      }
    }
  }
  if (rewards > 0) await notify(db, { audience: 'operations', kind: 'program_rewards_pending', payload: { count: rewards }, dedupeKey: `program_rewards_pending:rank:${Date.now()}` });
  return { ranks, rewards };
}

// -----------------------------------------------------------------------------
// Review and posting
// -----------------------------------------------------------------------------
export interface FundPosition {
  balance: bigint;
  /** Approved but unpaid referral and program rewards, plus pending bonuses from the fund. */
  committed: bigint;
  available: bigint;
}

/** What the reward fund can still take on for one token. */
export async function fundPosition(db: Db, tokenId: number): Promise<FundPosition> {
  const r = await one<{ balance: string; committed: string }>(
    db,
    `select coalesce((select b.balance from public.ledger_accounts a join public.account_balances b on b.account_id = a.id
                       where a.purpose = 'referral_reward_fund' and a.token_id = $1), 0)::text as balance,
            (coalesce((select sum(amount_base) from public.program_rewards where token_id = $1 and status = 'approved'), 0)
             + coalesce((select sum(amount_base) from public.referral_rewards where token_id = $1 and status = 'approved'), 0)
             + coalesce((select sum(amount_base) from public.manual_adjustments
                          where token_id = $1 and status = 'pending' and fund = 'referral_reward_fund' and direction = 'credit'), 0))::text as committed`,
    [tokenId],
  );
  const balance = parseBase(r.balance);
  const committed = parseBase(r.committed);
  return { balance, committed, available: balance - committed };
}

/**
 * Administrator decision on a pending reward. Approval reserves: it is refused
 * unless the fund covers this reward on top of everything already approved
 * (serialized per token). A staff member may not decide a reward that pays
 * them or matches their own earning, except a sole administrator (alerted).
 */
export async function reviewProgramReward(
  db: Db,
  args: { rewardId: string; decision: 'approve' | 'reject'; note: string; staffUserId: string; actor: Actor },
): Promise<void> {
  const note = args.note.trim();
  if (note.length < MIN_NOTE) throw new ProgramRewardError(`A note of at least ${MIN_NOTE} characters is required`, 'note_required');
  const r = await maybeOne<{ id: string; kind: string; beneficiary_user_id: string; source_user_id: string | null; amount_base: string; token_id: number; status: string }>(
    db,
    'select id, kind, beneficiary_user_id, source_user_id, amount_base::text, token_id, status from public.program_rewards where id = $1 for update',
    [args.rewardId],
  );
  if (!r) throw new ProgramRewardError('Reward not found', 'not_found');
  if (r.status !== 'pending') throw new ProgramRewardError(`This reward is already ${r.status}`, 'invalid_state');
  const toSelf = r.beneficiary_user_id === args.staffUserId || r.source_user_id === args.staffUserId;
  if (toSelf && !(await isSoleAdmin(db, args.staffUserId))) throw new ProgramRewardError('Staff cannot review a reward they are part of', 'conflict_of_interest');

  const tokenId = Number(r.token_id);
  const amount = parseBase(r.amount_base);
  if (args.decision === 'approve') {
    await db.query("select pg_advisory_xact_lock(hashtext('reward_fund:' || $1::text))", [tokenId]);
    const fund = await fundPosition(db, tokenId);
    if (fund.available < amount) {
      throw new ProgramRewardError('Awaiting funding: the reward pool does not cover this reward on top of those already approved. Top up the pool first.', 'awaiting_funding');
    }
  }
  const status = args.decision === 'approve' ? 'approved' : 'rejected';
  await db.query('update public.program_rewards set status = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4 where id = $1', [r.id, status, args.staffUserId, note]);
  const details = { kind: r.kind, beneficiaryUserId: r.beneficiary_user_id, amountBase: r.amount_base, tokenId, note, toSelf };
  await recordAudit(db, args.actor, `program.reward_${status}`, { type: 'program_reward', id: r.id }, details);
  if (status === 'approved' || toSelf) {
    await raiseRiskEvent(db, {
      userId: r.beneficiary_user_id,
      kind: toSelf ? 'admin_self_program_reward' : 'program_reward_approved',
      severity: 'high',
      subjectType: 'program_reward',
      subjectId: r.id,
      details,
    });
  }
  if (status === 'rejected') {
    await notify(db, { userId: r.beneficiary_user_id, kind: 'program_reward_rejected', payload: { rewardId: r.id, reason: note }, dedupeKey: `program_reward:${r.id}:rejected` });
  }
}

export type ProgramPostOutcome = 'posted' | 'deferred' | 'cancelled' | 'unchanged';

/**
 * Worker: pay an approved reward from the fund. Holds (with a recorded reason)
 * while the fund is short, the member is not active, or allocations are
 * paused; cancels a matching reward whose source earning was reversed.
 * Idempotent via the status check under lock and the ledger key.
 */
export async function postProgramReward(db: Db, rewardId: string, actor: Actor): Promise<ProgramPostOutcome> {
  const r = await maybeOne<{ id: string; kind: string; beneficiary_user_id: string; amount_base: string; token_id: number; status: string; error: string | null; source_entry_id: string | null; level: number | null; rank_code: string | null }>(
    db,
    'select id, kind, beneficiary_user_id, amount_base::text, token_id, status, error, source_entry_id, level, rank_code from public.program_rewards where id = $1 for update',
    [rewardId],
  );
  if (!r || r.status !== 'approved') return 'unchanged';
  const hold = async (reason: string): Promise<ProgramPostOutcome> => {
    if (r.error !== reason) {
      await db.query('update public.program_rewards set error = $2 where id = $1', [r.id, reason]);
      await raiseRiskEvent(db, { kind: 'program_reward_held', severity: 'medium', subjectType: 'program_reward', subjectId: r.id, details: { reason } });
    }
    return 'deferred';
  };
  if (await isControlEnabled(db, 'allocations_paused')) return 'deferred';
  // Paid only once the member has claimed it.
  if (!(await one<{ c: boolean }>(db, `select ${PROGRAM_CLAIMED_SQL} is not null as c from public.program_rewards r where r.id = $1`, [r.id])).c) return 'deferred';
  if (r.source_entry_id && (await one<{ v: boolean }>(db, `select ${reversedSql('$1::bigint')} as v`, [r.source_entry_id])).v) {
    await db.query("update public.program_rewards set status = 'cancelled', error = 'the matched earning was reversed' where id = $1", [r.id]);
    await recordAudit(db, actor, 'program.reward_cancelled', { type: 'program_reward', id: r.id }, { reason: 'source reversed' });
    return 'cancelled';
  }
  const member = await one<{ account_status: string }>(db, 'select account_status::text from public.user_profiles where user_id = $1', [r.beneficiary_user_id]);
  if (member.account_status !== 'active') return hold(`member account is ${member.account_status}`);

  const tokenId = Number(r.token_id);
  const amount = parseBase(r.amount_base);
  const fund = await ensureAccount(db, 'referral_reward_fund', tokenId);
  if ((await lockBalance(db, fund)) < amount) return hold('reward pool is too low; top it up from the group wallet');
  const cash = await ensureAccount(db, 'user_cash', tokenId, { userId: r.beneficiary_user_id });
  const description = r.kind === 'matching' ? `Matching bonus (level ${r.level})` : `Rank reward ${r.rank_code}`;
  const entryId = await postEntry(db, {
    idempotencyKey: `program_reward:${r.id}`,
    eventType: 'program_reward',
    sourceType: 'program_reward',
    sourceId: r.id,
    description,
    postedBy: `${actor.type}:${actor.id}`,
    lines: transfer(fund, cash, amount),
    metadata: { kind: r.kind, level: r.level, rank: r.rank_code },
  });
  await db.query("update public.program_rewards set status = 'posted', entry_id = $2, posted_at = now(), error = null where id = $1", [r.id, entryId]);
  await notify(db, { userId: r.beneficiary_user_id, kind: 'program_reward_paid', payload: { rewardId: r.id, amountBase: r.amount_base, description }, dedupeKey: `program_reward:${r.id}:paid` });
  await recordAudit(db, actor, 'program.reward_posted', { type: 'program_reward', id: r.id }, { entryId });
  return 'posted';
}

export async function listApprovedProgramRewardIds(db: Db): Promise<string[]> {
  return (await many<{ id: string }>(db, `select r.id from public.program_rewards r where r.status = 'approved' and ${PROGRAM_CLAIMED_SQL} is not null order by r.reviewed_at limit 100`)).map((r) => r.id);
}

// -----------------------------------------------------------------------------
// Sign-up placement
// -----------------------------------------------------------------------------
export interface PlacementAvailability {
  sponsorCode: string;
  mode: RewardsProgram['placement_mode'];
  /** Whether the spot directly under the sponsor is free on each side. */
  direct: Record<Side, boolean>;
}

/** Where a sign-up with this referral id could go. Null if the id is not an active member. */
export async function placementAvailability(db: Db, referralCode: string): Promise<PlacementAvailability | null> {
  const sponsor = await maybeOne<{ user_id: string; member_code: string }>(
    db,
    "select user_id, member_code from public.user_profiles where member_code = $1 and account_status = 'active'",
    [referralCode.trim().toUpperCase()],
  );
  if (!sponsor) return null;
  const [taken, { params }, admin] = await Promise.all([
    many<{ side: Side }>(db, 'select side from public.binary_placements where parent_user_id = $1', [sponsor.user_id]),
    effectiveProgram(db),
    maybeOne(db, "select 1 from public.staff_roles where user_id = $1 and role = 'admin'", [sponsor.user_id]),
  ]);
  return {
    sponsorCode: sponsor.member_code,
    // An administrator's referral id never fills up: sign-ups go further down the chosen side (see place_new_member).
    mode: admin ? 'outer' : params.placement_mode,
    direct: { left: !taken.some((t) => t.side === 'left'), right: !taken.some((t) => t.side === 'right') },
  };
}

// -----------------------------------------------------------------------------
// Read models
// -----------------------------------------------------------------------------

/** Read through jsonb so this works before the claims migration is applied. */
const PROGRAM_CLAIMED_SQL = `(to_jsonb(r) ->> 'claimed_at')`;

/**
 * The member claims their recorded matching or rank reward. It is paid only
 * after the owner claims it and an administrator approves it, in either order.
 */
export async function claimProgramReward(db: Db, args: { userId: string; rewardId: string; actor: Actor }): Promise<void> {
  const r = await maybeOne<{ id: string; status: string; claimed: string | null; amount_base: string; kind: string }>(
    db,
    `select r.id, r.status, ${PROGRAM_CLAIMED_SQL} as claimed, r.amount_base::text, r.kind from public.program_rewards r where r.id = $1 and r.beneficiary_user_id = $2 for update`,
    [args.rewardId, args.userId],
  );
  if (!r) throw new ProgramRewardError('Reward not found', 'not_found');
  if (r.claimed) return;
  if (r.status !== 'pending' && r.status !== 'approved') throw new ProgramRewardError(`This reward is ${r.status} and cannot be claimed`, 'not_claimable');
  await db.query('update public.program_rewards set claimed_at = now() where id = $1', [r.id]);
  await recordAudit(db, args.actor, 'program.reward_claimed', { type: 'program_reward', id: r.id }, { kind: r.kind, amountBase: r.amount_base });
  await notify(db, { audience: 'operations', kind: 'reward_claimed', payload: { rewardId: r.id, kind: r.kind }, dedupeKey: `reward_claimed:program:${r.id}` });
}

export interface ProgramRewardView {
  id: string;
  kind: 'matching' | 'rank';
  amount_base: string;
  symbol: string;
  decimals: number;
  level: number | null;
  rate_bps: number | null;
  base_amount: string | null;
  rank_code: string | null;
  source_code: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'posted';
  error: string | null;
  created_at: Date;
  posted_at: Date | null;
  entry_id: string | null;
  claimed_at: string | null;
}

const REWARD_COLUMNS = `r.id, r.kind, r.amount_base::text, t.symbol, t.decimals, r.level, r.rate_bps, r.base_amount::text, r.rank_code,
  s.member_code as source_code, r.status, r.error, r.created_at, r.posted_at, r.entry_id::text, (to_jsonb(r) ->> 'claimed_at') as claimed_at`;

export async function listProgramRewards(db: Db, userId: string): Promise<ProgramRewardView[]> {
  return many<ProgramRewardView>(
    db,
    `select ${REWARD_COLUMNS} from public.program_rewards r join public.supported_tokens t on t.id = r.token_id
       left join public.user_profiles s on s.user_id = r.source_user_id
      where r.beneficiary_user_id = $1 order by r.created_at desc limit 200`,
    [userId],
  );
}

export async function adminProgramRewards(db: Db) {
  return many<ProgramRewardView & { beneficiary_user_id: string; beneficiary_email: string; beneficiary_code: string; review_note: string | null; policy_version: number }>(
    db,
    `select ${REWARD_COLUMNS}, r.beneficiary_user_id, b.email as beneficiary_email, b.member_code as beneficiary_code, r.review_note, v.version as policy_version
       from public.program_rewards r join public.supported_tokens t on t.id = r.token_id
       join public.user_profiles b on b.user_id = r.beneficiary_user_id
       join public.policy_versions v on v.id = r.policy_version_id
       left join public.user_profiles s on s.user_id = r.source_user_id
      order by (r.status in ('pending', 'approved')) desc, r.created_at desc limit 300`,
  );
}

/** Ranks the member holds now, after administrator corrections. */
export async function rankHistory(db: Db, userId: string) {
  return many<{ rank_code: string; achieved_at: Date; source: 'achieved' | 'granted'; left_volume: string; right_volume: string; self_volume: string }>(
    db,
    'select rank_code, achieved_at, source, left_volume::text, right_volume::text, self_volume::text from public.member_ranks where user_id = $1 order by achieved_at',
    [userId],
  );
}

/** Every rank correction for a member, newest first. */
export async function rankCorrections(db: Db, userId: string) {
  return many<{ id: string; rank_code: string; action: 'revoke' | 'grant'; reason: string; created_at: Date; created_by_email: string | null }>(
    db,
    `select c.id::text, c.rank_code, c.action, c.reason, c.created_at, u.email as created_by_email
       from public.rank_corrections c left join public.user_profiles u on u.user_id = c.created_by
      where c.user_id = $1 order by c.id desc limit 50`,
    [userId],
  );
}

/**
 * Administrator: revoke a rank a member holds, or grant one they do not. The
 * correction is appended (never edited) and the latest one per rank wins, so a
 * mistake is undone with the opposite correction. Revoking rejects the rank's
 * reward if it is still pending review; once approved it is left to be paid and
 * taken back afterwards with an income correction. Granting creates no reward.
 */
export async function correctRank(
  db: Db,
  args: { userId: string; rankCode: string; action: 'revoke' | 'grant'; reason: string; staffUserId: string; actor: Actor },
): Promise<void> {
  const reason = args.reason.trim();
  if (reason.length < MIN_NOTE) throw new ProgramRewardError(`A reason of at least ${MIN_NOTE} characters is required`, 'reason_required');
  const { params: program } = await effectiveProgram(db);
  if (rankOrder(args.rankCode, program.ranks.levels) === 0) throw new ProgramRewardError('Unknown rank', 'invalid_rank');
  const member = await maybeOne<{ user_id: string }>(db, 'select user_id from public.user_profiles where user_id = $1', [args.userId]);
  if (!member) throw new ProgramRewardError('Member not found', 'not_found');
  // Serialize corrections for this member.
  await db.query("select pg_advisory_xact_lock(hashtext('rank_correction:' || $1::text))", [args.userId]);
  const held = await maybeOne<{ source: string }>(db, 'select source from public.member_ranks where user_id = $1 and rank_code = $2', [args.userId, args.rankCode]);
  if (args.action === 'revoke' && !held) throw new ProgramRewardError(`The member does not hold ${args.rankCode}`, 'invalid_state');
  if (args.action === 'grant' && held) throw new ProgramRewardError(`The member already holds ${args.rankCode}`, 'invalid_state');

  let rejectedRewardId: string | null = null;
  if (args.action === 'revoke') {
    const reward = await maybeOne<{ id: string; status: string }>(
      db,
      "select id, status from public.program_rewards where kind = 'rank' and beneficiary_user_id = $1 and rank_code = $2 for update",
      [args.userId, args.rankCode],
    );
    if (reward?.status === 'approved') {
      throw new ProgramRewardError('This rank reward is approved and about to be paid. Let it post, then take it back with an income correction and revoke the rank.', 'reward_approved');
    }
    if (reward?.status === 'pending') {
      await db.query("update public.program_rewards set status = 'rejected', reviewed_by = $2, reviewed_at = now(), review_note = $3 where id = $1", [
        reward.id,
        args.staffUserId,
        `Rank revoked: ${reason}`,
      ]);
      rejectedRewardId = reward.id;
    }
  }

  const row = await one<{ id: string }>(
    db,
    'insert into public.rank_corrections (user_id, rank_code, action, reason, created_by) values ($1, $2, $3, $4, $5) returning id::text',
    [args.userId, args.rankCode, args.action, reason, args.staffUserId],
  );
  const details = { rankCode: args.rankCode, action: args.action, reason, rejectedRewardId };
  await recordAudit(db, args.actor, `program.rank_${args.action === 'revoke' ? 'revoked' : 'granted'}`, { type: 'user', id: args.userId }, details);
  await raiseRiskEvent(db, { userId: args.userId, kind: 'rank_corrected', severity: 'high', subjectType: 'rank_correction', subjectId: row.id, details });
  await notify(db, {
    userId: args.userId,
    kind: args.action === 'revoke' ? 'rank_revoked' : 'rank_granted',
    payload: { rank: args.rankCode, reason },
    dedupeKey: `rank_correction:${row.id}`,
  });
}

/** Everything the member rewards page shows, from the database (never client input). */
export async function memberProgramOverview(db: Db, userId: string) {
  const { params: program, version } = await effectiveProgram(db);
  const [vols, ranks, profile, direct, placement, rewards, history] = await Promise.all([
    memberVolumes(db, [userId]),
    highestRanks(db, [userId], program.ranks.levels),
    one<{ account_status: string }>(db, 'select account_status::text from public.user_profiles where user_id = $1', [userId]),
    one<{ n: number }>(db, 'select count(*)::int as n from public.user_profiles where sponsor_user_id = $1', [userId]),
    maybeOne<{ parent_code: string; side: Side; placed_at: Date }>(
      db,
      `select p.member_code as parent_code, b.side, b.placed_at from public.binary_placements b
         join public.user_profiles p on p.user_id = b.parent_user_id where b.user_id = $1`,
      [userId],
    ),
    listProgramRewards(db, userId),
    rankHistory(db, userId),
  ]);
  const volumes = vols.get(userId) ?? { left: 0n, right: 0n, self: 0n, leftCount: 0, rightCount: 0 };
  const highest = ranks.get(userId) ?? 0;
  return {
    program,
    version,
    volumes,
    highestRankOrder: highest,
    eligibility: matchingEligibility({ active: profile.account_status === 'active', volumes, highestRankOrder: highest }, program),
    directReferrals: Number(direct.n),
    placement,
    rewards,
    history,
  };
}

/**
 * Reward treasury per token: the pool balance, what is committed, and every
 * flow in and out by kind, with a check that the cached balance equals the sum
 * of its ledger lines. Funding is real only as far as the group-wallet
 * reconciliation (Treasury page) confirms the receipts it came from.
 */
export async function rewardTreasury(db: Db) {
  const tokens = await many<{ token_id: number; symbol: string; decimals: number; cached: string; from_lines: string }>(
    db,
    `select a.token_id, t.symbol, t.decimals, coalesce(b.balance, 0)::text as cached,
            coalesce((select sum(case when l.direction = 'C' then l.amount else -l.amount end) from public.journal_lines l where l.account_id = a.id), 0)::text as from_lines
       from public.ledger_accounts a join public.supported_tokens t on t.id = a.token_id
       left join public.account_balances b on b.account_id = a.id
      where a.purpose = 'referral_reward_fund' order by a.token_id`,
  );
  const flows = await many<{ token_id: number; event_type: string; inflow: string; outflow: string; entries: number }>(
    db,
    `select l.token_id, e.event_type,
            coalesce(sum(l.amount) filter (where l.direction = 'C'), 0)::text as inflow,
            coalesce(sum(l.amount) filter (where l.direction = 'D'), 0)::text as outflow,
            count(distinct e.id)::int as entries
       from public.journal_lines l join public.ledger_accounts a on a.id = l.account_id and a.purpose = 'referral_reward_fund'
       join public.journal_entries e on e.id = l.entry_id
      group by l.token_id, e.event_type order by l.token_id, e.event_type`,
  );
  return Promise.all(
    tokens.map(async (t) => ({
      tokenId: Number(t.token_id),
      symbol: t.symbol,
      decimals: Number(t.decimals),
      position: await fundPosition(db, Number(t.token_id)),
      reconciled: t.cached === t.from_lines,
      flows: flows.filter((f) => Number(f.token_id) === Number(t.token_id)),
    })),
  );
}
