/**
 * Team position at sign-up, matching bonus and rank rewards.
 *
 * Positions are chosen at sign-up and placed atomically with the account.
 * Volumes and matching bases are operator-funded earnings only (bonuses and
 * referral rewards from the reward pool), never deposits. Rewards are recorded
 * once, approved only when the pool covers them, and paid from the pool alone.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { admin, balanceOf, closePools, createUser, resetAppData, simAdapter, simDeposit, simToken, usdt, web, worker } from '../helpers/db';
import { many, one, withTransaction } from '../../src/server/db-core';
import { checkIntegrity } from '../../src/server/ledger/ledger';
import { SimulatedChainAdapter } from '../../src/server/chains/simulated';
import { creditDeposit, ingestNetwork, refreshDeposit } from '../../src/server/deposits/service';
import { createAllocation, postAllocation, type AllocationKind } from '../../src/server/deposits/allocations';
import { createAdjustment, postAdjustment, reverseAdjustment } from '../../src/server/adjustments/manual';
import {
  correctRank,
  detectMatchingRewards,
  evaluateRanks,
  memberProgramOverview,
  memberVolumes,
  placementAvailability,
  postProgramReward,
  reviewProgramReward,
  saveProgramPolicy,
} from '../../src/server/referrals/program';
import { checkRegistration } from '../../src/server/signup';
import { DEFAULT_PROGRAM, usdFixed } from '../../src/server/referrals/program-math';
import type { RewardsProgram } from '../../src/server/ops';
import { getRewardIncome } from '../../src/server/queries/user';

const GROUP = '0x0000000000000000000000000000000000000a07';
const service = { type: 'service' as const, id: 'test' };
let adminId: string;
let tokenId: number;

beforeEach(async () => {
  await resetAppData();
  await admin.query('update public.treasury_wallets set receives_deposits = true where address = $1', [GROUP]);
  tokenId = (await simToken()).id;
  adminId = await createUser();
  await admin.query("insert into public.staff_roles (user_id, role) values ($1, 'admin')", [adminId]);
});
afterAll(closePools);

const staff = () => ({ type: 'staff' as const, id: adminId });
const code = async (userId: string) => (await one<{ member_code: string }>(admin, 'select member_code from public.user_profiles where user_id = $1', [userId])).member_code;
const placement = (userId: string) =>
  one<{ parent_user_id: string; side: string; placed_by: string }>(admin, 'select parent_user_id, side, placed_by from public.binary_placements where user_id = $1', [userId]);
const clean = { unbalancedTokens: [], cacheMismatches: [] };

/** An unattributed group-wallet receipt, received into suspense. */
async function receipt(amount: string) {
  await simDeposit(GROUP, usdt(amount), 5, { from: '0x4444444444444444444444444444444444444444' });
  await admin.query('delete from public.network_scan_state');
  const adapter = await simAdapter();
  await ingestNetwork(worker, adapter);
  const d = await one<{ id: string }>(admin, "select id from public.deposits where user_id is null and status in ('detected', 'confirming', 'confirmed') limit 1");
  await withTransaction(worker, (db) => refreshDeposit(db, new SimulatedChainAdapter(adapter.network, db), d.id));
  await withTransaction(worker, (db) => creditDeposit(db, d.id));
  return d.id;
}

async function allocate(depositId: string, kind: AllocationKind, lines: { userId: string; amount: string }[]) {
  const a = await withTransaction(web, (db) => createAllocation(db, { depositId, kind, reason: 'Rewards test allocation', lines, staffUserId: adminId, actor: staff() }));
  expect(await withTransaction(worker, (db) => postAllocation(db, a.id, service))).toBe('posted');
}

/** Operator money into the reward pool. */
const fundPool = async (amount: string) => allocate(await receipt(amount), 'referral_fund', []);

/** An administrator bonus for work, paid from the pool: an operator-funded earning. */
async function bonus(userId: string, amount: string) {
  const a = await withTransaction(web, (db) =>
    createAdjustment(db, { userId, tokenId, direction: 'credit', amount, reason: 'Bonus for organising the meetup', fund: 'referral_reward_fund', staffUserId: adminId, actor: staff() }),
  );
  expect(await withTransaction(worker, (db) => postAdjustment(db, a.id, service))).toBe('posted');
  return a.id;
}

const save = (overrides: Partial<RewardsProgram> = {}) =>
  withTransaction(web, (db) => saveProgramPolicy(db, staff(), { ...DEFAULT_PROGRAM, program_start: '2000-01-01T00:00:00.000Z', ...overrides }, 'Configure the rewards program'));

const matchingOn = (min = '0', extra: Partial<RewardsProgram['matching']> = {}) => save({ matching: { ...DEFAULT_PROGRAM.matching, enabled: true, min_left: min, min_right: min, ...extra } });

const review = (rewardId: string, decision: 'approve' | 'reject' = 'approve', staffUserId = adminId) =>
  withTransaction(web, (db) => reviewProgramReward(db, { rewardId, decision, note: 'Checked the calculation by hand', staffUserId, actor: { type: 'staff', id: staffUserId } }));
/** The member's claim, which payment waits for (set directly; claim rules are tested in referrals.test.ts). */
const post = async (id: string) => {
  await admin.query("update public.program_rewards set claimed_at = now() where id = $1 and claimed_at is null and status in ('pending', 'approved')", [id]);
  return withTransaction(worker, (db) => postProgramReward(db, id, service));
};
const detect = () => withTransaction(worker, (db) => detectMatchingRewards(db));
const rewards = () =>
  many<{ id: string; kind: string; beneficiary_user_id: string; level: number | null; amount_base: string; status: string; rank_code: string | null; error: string | null }>(
    admin,
    'select id, kind, beneficiary_user_id, level, amount_base::text, status, rank_code, error from public.program_rewards order by level nulls last, created_at',
  );

describe('team position at sign-up', () => {
  it('places the member under the sponsor on the chosen side, in the same transaction, and records who chose it', async () => {
    const sponsor = await createUser();
    const left = await createUser({ referralCode: await code(sponsor), side: 'left' });
    expect(await placement(left)).toEqual({ parent_user_id: sponsor, side: 'left', placed_by: left });
    const h = await one<{ reason: string; changed_by: string }>(admin, 'select reason, changed_by from public.placement_history where user_id = $1', [left]);
    expect(h).toEqual({ reason: 'Chosen by the member at sign-up', changed_by: left });
    // No referral id, no position.
    const loner = await createUser({ side: 'right' });
    expect((await admin.query('select 1 from public.binary_placements where user_id = $1', [loner])).rowCount).toBe(0);
  });

  it('outer mode keeps the chosen side and goes down its outer edge, so sponsor and parent can differ', async () => {
    const sponsor = await createUser();
    const ref = await code(sponsor);
    const a = await createUser({ referralCode: ref, side: 'left' });
    const b = await createUser({ referralCode: ref, side: 'left' });
    const c = await createUser({ referralCode: ref, side: 'left' });
    expect(await placement(b)).toMatchObject({ parent_user_id: a, side: 'left' });
    expect(await placement(c)).toMatchObject({ parent_user_id: b, side: 'left' });
    expect((await one<{ s: string }>(admin, 'select sponsor_user_id as s from public.user_profiles where user_id = $1', [c])).s).toBe(sponsor);
    expect(await placementAvailability(web, ref)).toEqual({ sponsorCode: ref, mode: 'outer', direct: { left: false, right: true } });
  });

  it('direct mode refuses a taken side, without switching it, both before and inside the sign-up', async () => {
    await save({ placement_mode: 'direct' });
    const sponsor = await createUser();
    const ref = await code(sponsor);
    await createUser({ referralCode: ref, side: 'left' });
    await expect(checkRegistration(web, { username: 'new_member', referralCode: ref, teamSide: 'left' })).rejects.toMatchObject({ code: 'position_taken' });
    await expect(checkRegistration(web, { username: 'new_member', referralCode: ref, teamSide: null })).rejects.toMatchObject({ code: 'team_side_required' });
    await expect(checkRegistration(web, { username: 'new_member', referralCode: ref, teamSide: 'right' })).resolves.toBeUndefined();
    // The database refuses it too, and the whole account is rolled back.
    const before = (await one<{ n: number }>(admin, 'select count(*)::int as n from auth.users')).n;
    await expect(createUser({ referralCode: ref, side: 'left' })).rejects.toThrow(/team position taken/);
    expect((await one<{ n: number }>(admin, 'select count(*)::int as n from auth.users')).n).toBe(before);
    const right = await createUser({ referralCode: ref, side: 'right' });
    expect(await placement(right)).toMatchObject({ parent_user_id: sponsor, side: 'right' });
  });

  it("never fills up an administrator's referral id: every sign-up goes directly under them, in either mode", async () => {
    for (const mode of ['direct', 'outer'] as const) {
      await save({ placement_mode: mode });
      const ref = await code(adminId);
      await createUser({ referralCode: ref, side: 'left' });
      expect(await placementAvailability(web, ref)).toMatchObject({ mode: 'direct', direct: { left: true, right: true } });
      await expect(checkRegistration(web, { username: `second_left_${mode}`, referralCode: ref, teamSide: 'left' })).resolves.toBeUndefined();
      const second = await createUser({ referralCode: ref, side: 'left' });
      expect(await placement(second)).toMatchObject({ parent_user_id: adminId, side: 'left' });
    }
  });

  it('never lets two concurrent sign-ups take the same position', async () => {
    const sponsor = await createUser();
    const ref = await code(sponsor);
    const ids = await Promise.all([1, 2, 3, 4].map(() => createUser({ referralCode: ref, side: 'right' })));
    const rows = await many<{ parent_user_id: string }>(admin, 'select parent_user_id from public.binary_placements where user_id = any($1::uuid[])', [ids]);
    expect(new Set(rows.map((r) => r.parent_user_id)).size).toBe(4);
  });
});

describe('reward base', () => {
  it('counts operator-funded earnings and never deposits', async () => {
    const sponsor = await createUser();
    const member = await createUser({ referralCode: await code(sponsor), side: 'left' });
    await allocate(await receipt('500'), 'assignment', [{ userId: member, amount: '500' }]);
    await fundPool('100');
    let v = await memberVolumes(web, [sponsor, member]);
    expect(v.get(member)!.self).toBe(0n);
    expect(v.get(sponsor)!.left).toBe(0n);

    const adj = await bonus(member, '40');
    v = await memberVolumes(web, [sponsor, member]);
    expect(v.get(member)!.self).toBe(usdFixed('40'));
    expect(v.get(sponsor)).toMatchObject({ left: usdFixed('40'), right: 0n, leftCount: 1, rightCount: 0 });

    // A reversed bonus no longer counts.
    const rev = await withTransaction(web, (db) => reverseAdjustment(db, { adjustmentId: adj, reason: 'Bonus was recorded twice', staffUserId: adminId, actor: staff() }));
    await withTransaction(worker, (db) => postAdjustment(db, rev.id, service));
    expect((await memberVolumes(web, [member])).get(member)!.self).toBe(0n);
  });

  it('reports total income as rewards paid from the pool, net of reversals, never deposits', async () => {
    const member = await createUser();
    await allocate(await receipt('500'), 'assignment', [{ userId: member, amount: '500' }]);
    await fundPool('100');
    expect(await getRewardIncome(web, member, tokenId)).toBe(0n);
    const adj = await bonus(member, '40');
    await bonus(member, '10');
    expect(await getRewardIncome(web, member, tokenId)).toBe(usdt('50'));
    const rev = await withTransaction(web, (db) => reverseAdjustment(db, { adjustmentId: adj, reason: 'Bonus was recorded twice', staffUserId: adminId, actor: staff() }));
    await withTransaction(worker, (db) => postAdjustment(db, rev.id, service));
    expect(await getRewardIncome(web, member, tokenId)).toBe(usdt('10'));
  });

  it('lets the administrator correct income paid by mistake, back into the pool and out of earnings', async () => {
    const sponsor = await createUser();
    const member = await createUser({ referralCode: await code(sponsor), side: 'left' });
    await fundPool('100');
    await bonus(member, '30');
    const correct = (amount: string, reason: string) =>
      withTransaction(web, (db) =>
        createAdjustment(db, { userId: member, tokenId, direction: 'debit', amount, reason, fund: 'referral_reward_fund', staffUserId: adminId, actor: staff() }),
      );
    const fix = await correct('12', 'Bonus paid twice by a glitch');
    expect(await withTransaction(worker, (db) => postAdjustment(db, fix.id, service))).toBe('posted');
    expect(await withTransaction(worker, (db) => postAdjustment(db, fix.id, service))).toBe('unchanged');
    expect(await balanceOf('user_cash', tokenId, member)).toBe(usdt('18'));
    expect(await balanceOf('referral_reward_fund', tokenId)).toBe(usdt('82'));
    expect(await balanceOf('operator_float', tokenId)).toBe(0n);
    expect(await getRewardIncome(web, member, tokenId)).toBe(usdt('18'));
    const v = await memberVolumes(web, [sponsor, member]);
    expect(v.get(member)!.self).toBe(usdFixed('18'));
    expect(v.get(sponsor)!.left).toBe(usdFixed('18'));
    const ev = await one<{ event_type: string }>(admin, "select event_type from public.journal_entries where source_type = 'manual_adjustment' and source_id = $1", [fix.id]);
    expect(ev.event_type).toBe('income_correction');

    // More than the member holds fails instead of going negative.
    const big = await correct('50', 'Correction larger than the balance');
    expect(await withTransaction(worker, (db) => postAdjustment(db, big.id, service))).toBe('failed');
    expect(await withTransaction(worker, (db) => checkIntegrity(db))).toEqual(clean);
  });
});

describe('matching bonus', () => {
  /** A ← B ← C by referral (C referred by B, B by A). */
  async function chain() {
    const a = await createUser();
    const b = await createUser({ referralCode: await code(a), side: 'left' });
    const c = await createUser({ referralCode: await code(b), side: 'left' });
    return { a, b, c };
  }

  it('records nothing while matching is off', async () => {
    await save();
    const { c } = await chain();
    await fundPool('200');
    await bonus(c, '100');
    expect(await detect()).toBe(0);
    expect(await rewards()).toEqual([]);
  });

  it('matches each earning once per level, reserves on approval and pays from the pool only', async () => {
    await matchingOn('0');
    const { a, b, c } = await chain();
    await fundPool('100');
    await bonus(c, '100'); // pool now 0
    expect(await detect()).toBe(2);
    expect(await detect()).toBe(0); // processed once
    const [l1, l2] = await rewards();
    expect(l1).toMatchObject({ kind: 'matching', beneficiary_user_id: b, level: 1, amount_base: usdt('5').toString(), status: 'pending' });
    expect(l2).toMatchObject({ beneficiary_user_id: a, level: 2, amount_base: usdt('5').toString() });

    // Empty pool: approval is refused (awaiting funding), never paid from members' money.
    await expect(review(l1!.id)).rejects.toMatchObject({ code: 'awaiting_funding' });
    await fundPool('8');
    await review(l1!.id);
    // 8 funded, 5 committed: the second 5 does not fit.
    await expect(review(l2!.id)).rejects.toMatchObject({ code: 'awaiting_funding' });

    expect(await post(l1!.id)).toBe('posted');
    expect(await post(l1!.id)).toBe('unchanged');
    expect(await balanceOf('user_cash', tokenId, b)).toBe(usdt('5'));
    expect(await getRewardIncome(web, b, tokenId)).toBe(usdt('5'));
    expect(await balanceOf('referral_reward_fund', tokenId)).toBe(usdt('3'));
    // Matching rewards are not earnings themselves: no matching on matching.
    expect(await detect()).toBe(0);
    expect(await withTransaction(worker, (db) => checkIntegrity(db))).toEqual(clean);
  });

  it('skips members below the side minimums, and refuses self-review', async () => {
    await matchingOn('50');
    const { b, c } = await chain();
    await fundPool('300');
    // B's left team (C) reaches 50, B's right team is empty: B is not eligible.
    await bonus(c, '100');
    await detect();
    expect(await rewards()).toEqual([]);

    // Give B a right team with 50 of earnings: the next earning of C is matched for B.
    const r = await createUser({ referralCode: await code(b), side: 'right' });
    await bonus(r, '50');
    await detect();
    await bonus(c, '20');
    await detect();
    const got = await rewards();
    expect(got.map((x) => [x.beneficiary_user_id, x.level, x.amount_base])).toContainEqual([b, 1, usdt('1').toString()]);

    // A member cannot decide a reward that pays them.
    await expect(review(got.find((x) => x.beneficiary_user_id === b)!.id, 'approve', b)).rejects.toMatchObject({ code: 'conflict_of_interest' });
  });

  it('cancels an approved matching reward whose earning was reversed before payment', async () => {
    await matchingOn('0');
    const { c } = await chain();
    await fundPool('300');
    const adj = await bonus(c, '100');
    await detect();
    const [l1] = await rewards();
    await review(l1!.id);
    const rev = await withTransaction(web, (db) => reverseAdjustment(db, { adjustmentId: adj, reason: 'Work was not delivered', staffUserId: adminId, actor: staff() }));
    await withTransaction(worker, (db) => postAdjustment(db, rev.id, service));
    expect(await post(l1!.id)).toBe('cancelled');
    expect((await rewards())[0]).toMatchObject({ status: 'cancelled' });
  });
});

describe('ranks', () => {
  const ladder = (rewards_enabled: boolean) =>
    save({
      ranks: {
        rewards_enabled,
        token_id: rewards_enabled ? tokenId : null,
        levels: [
          { code: 'R1', left: '10', right: '10', self: '0', bonus: '2' },
          { code: 'R2', left: '1000', right: '1000', self: '0', bonus: '50' },
        ],
      },
    });

  async function team() {
    const s = await createUser();
    const ref = await code(s);
    const l = await createUser({ referralCode: ref, side: 'left' });
    const r = await createUser({ referralCode: ref, side: 'right' });
    await fundPool('100');
    await bonus(l, '10');
    await bonus(r, '10');
    return s;
  }

  it('records a reached rank once, with a pending reward when rank rewards are on', async () => {
    await ladder(true);
    const s = await team();
    expect(await withTransaction(worker, (db) => evaluateRanks(db))).toEqual({ ranks: 1, rewards: 1 });
    expect(await withTransaction(worker, (db) => evaluateRanks(db))).toEqual({ ranks: 0, rewards: 0 });
    const [r] = await rewards();
    expect(r).toMatchObject({ kind: 'rank', beneficiary_user_id: s, rank_code: 'R1', amount_base: usdt('2').toString(), status: 'pending' });
    await review(r!.id);
    expect(await post(r!.id)).toBe('posted');
    expect(await balanceOf('user_cash', tokenId, s)).toBe(usdt('2'));
    // A rank reward is not an earning: it does not raise anyone's volume.
    expect((await memberVolumes(web, [s])).get(s)!.self).toBe(0n);
    expect(await withTransaction(worker, (db) => checkIntegrity(db))).toEqual(clean);
  });

  it('tracks ranks without creating rewards while rank rewards are off', async () => {
    await ladder(false);
    await team();
    expect(await withTransaction(worker, (db) => evaluateRanks(db))).toEqual({ ranks: 1, rewards: 0 });
    expect(await rewards()).toEqual([]);
  });

  const correct = (userId: string, action: 'revoke' | 'grant', rankCode: string, reason = 'Rank recorded by a glitch') =>
    withTransaction(web, (db) => correctRank(db, { userId, rankCode, action, reason, staffUserId: adminId, actor: staff() }));
  const held = async (userId: string) => (await withTransaction(web, (db) => memberProgramOverview(db, userId))).history.map((h) => [h.rank_code, h.source]);

  it('revokes a wrong rank, rejects its pending reward, and the worker never re-awards it', async () => {
    await ladder(true);
    const s = await team();
    await withTransaction(worker, (db) => evaluateRanks(db));
    expect(await held(s)).toEqual([['R1', 'achieved']]);

    await correct(s, 'revoke', 'R1');
    expect(await held(s)).toEqual([]);
    expect((await withTransaction(web, (db) => memberProgramOverview(db, s))).highestRankOrder).toBe(0);
    const [r] = await rewards();
    expect(r).toMatchObject({ kind: 'rank', status: 'rejected' });
    // Volumes still meet R1, but a corrected rank is settled.
    expect(await withTransaction(worker, (db) => evaluateRanks(db))).toEqual({ ranks: 0, rewards: 0 });
    expect(await held(s)).toEqual([]);
    // The record of what was measured is kept.
    expect((await admin.query('select 1 from public.rank_achievements where user_id = $1', [s])).rowCount).toBe(1);
    await expect(admin.query('delete from public.rank_corrections')).rejects.toThrow();

    // Undo the mistake with the opposite correction.
    await correct(s, 'grant', 'R1', 'Revoked the wrong member');
    expect(await held(s)).toEqual([['R1', 'achieved']]);
    const risk = await one<{ n: number }>(admin, "select count(*)::int as n from public.risk_events where kind = 'rank_corrected' and severity = 'high'");
    expect(risk.n).toBe(2);
  });

  it('grants a rank without a reward and refuses impossible corrections', async () => {
    await ladder(true);
    const m = await createUser();
    await correct(m, 'grant', 'R2', 'Agreed with the group for past work');
    expect(await held(m)).toEqual([['R2', 'granted']]);
    expect(await withTransaction(worker, (db) => evaluateRanks(db))).toEqual({ ranks: 0, rewards: 0 });
    expect(await rewards()).toEqual([]);
    await expect(correct(m, 'grant', 'R2')).rejects.toMatchObject({ code: 'invalid_state' });
    await expect(correct(m, 'revoke', 'R1')).rejects.toMatchObject({ code: 'invalid_state' });
    await expect(correct(m, 'grant', 'NOPE')).rejects.toMatchObject({ code: 'invalid_rank' });
    await expect(correct(m, 'revoke', 'R2', 'short')).rejects.toMatchObject({ code: 'reason_required' });
  });

  it('refuses to revoke while the rank reward is approved but not yet paid', async () => {
    await ladder(true);
    const s = await team();
    await withTransaction(worker, (db) => evaluateRanks(db));
    const [r] = await rewards();
    await review(r!.id);
    await expect(correct(s, 'revoke', 'R1')).rejects.toMatchObject({ code: 'reward_approved' });
    expect(await post(r!.id)).toBe('posted');
    await correct(s, 'revoke', 'R1');
    expect(await held(s)).toEqual([]);
  });
});
