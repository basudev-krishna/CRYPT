/**
 * Administrator control of the referral network: sponsor corrections,
 * left/right positions, the team tree, and referral bonuses from the fund.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { admin, balanceOf, closePools, createUser, resetAppData, simAdapter, simDeposit, simToken, usdt, web, worker } from '../helpers/db';
import { one, withTransaction } from '../../src/server/db-core';
import { checkIntegrity } from '../../src/server/ledger/ledger';
import { SimulatedChainAdapter } from '../../src/server/chains/simulated';
import { creditDeposit, ingestNetwork, refreshDeposit } from '../../src/server/deposits/service';
import { createAllocation, postAllocation } from '../../src/server/deposits/allocations';
import { createAdjustment, postAdjustment, reverseAdjustment } from '../../src/server/adjustments/manual';
import { correctSponsor, removePlacement, setPlacement, teamTree, type Side } from '../../src/server/referrals/network';

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

const actor = () => ({ type: 'staff' as const, id: adminId });
const code = async (userId: string) => (await one<{ member_code: string }>(admin, 'select member_code from public.user_profiles where user_id = $1', [userId])).member_code;
const sponsorOf = async (userId: string) => (await one<{ s: string | null }>(admin, 'select sponsor_user_id as s from public.user_profiles where user_id = $1', [userId])).s;
const setSponsor = async (userId: string, sponsor: string | null) =>
  withTransaction(web, async (db) => correctSponsor(db, { userId, sponsorMemberCode: sponsor ? await code(sponsor) : null, reason: 'Corrected after a call', staffUserId: adminId, actor: actor() }));
const place = async (userId: string, parent: string, side: Side) =>
  withTransaction(web, async (db) => setPlacement(db, { userId, parentMemberCode: await code(parent), side, reason: 'Placed as agreed in the group', staffUserId: adminId, actor: actor() }));

describe('sponsor corrections', () => {
  it('lets an administrator change or clear the referrer, refuses loops, and keeps history', async () => {
    const a = await createUser();
    const b = await createUser({ referralCode: await code(a) });
    const c = await createUser();
    await setSponsor(b, c);
    expect(await sponsorOf(b)).toBe(c);
    // c → b would make b refer c who refers b.
    await expect(setSponsor(c, b)).rejects.toMatchObject({ code: 'not_allowed' });
    await setSponsor(b, null);
    expect(await sponsorOf(b)).toBeNull();
    const h = await admin.query('select old_sponsor_id, new_sponsor_id from public.sponsor_changes where user_id = $1 order by id', [b]);
    expect(h.rows).toEqual([
      { old_sponsor_id: a, new_sponsor_id: c },
      { old_sponsor_id: c, new_sponsor_id: null },
    ]);
    // Still immutable outside the correction function, for the web role and the owner alike.
    await expect(web.query('update public.user_profiles set sponsor_user_id = $2 where user_id = $1', [b, a])).rejects.toThrow();
    await expect(admin.query('update public.user_profiles set sponsor_user_id = $2 where user_id = $1', [b, a])).rejects.toThrow(/permanent/);
  });
});

describe('left/right positions', () => {
  it('places, refuses loops, moves whole teams and counts each side', async () => {
    const root = await createUser();
    const [l, r, ll] = [await createUser(), await createUser(), await createUser()];
    await place(l, root, 'left');
    await place(r, root, 'right');
    await place(ll, l, 'left');
    await expect(place(root, ll, 'right')).rejects.toMatchObject({ code: 'not_allowed' }); // root under its own team

    let t = (await teamTree(web, root))!;
    expect([t.leftCount, t.rightCount]).toEqual([2, 1]);
    expect(t.left[0]?.left[0]?.memberCode).toBe(await code(ll));

    // Moving l (with ll) under r's right side.
    await place(l, r, 'right');
    t = (await teamTree(web, root))!;
    expect([t.leftCount, t.rightCount]).toEqual([0, 3]);
    expect(t.right[0]?.right[0]?.left[0]?.memberCode).toBe(await code(ll));

    await withTransaction(web, (db) => removePlacement(db, { userId: l, reason: 'Left the group for now', staffUserId: adminId, actor: actor() }));
    t = (await teamTree(web, root))!;
    expect([t.leftCount, t.rightCount]).toEqual([0, 1]);
    expect((await admin.query('select count(*)::int as n from public.placement_history where user_id = $1', [l])).rows[0].n).toBe(3);
    await expect(admin.query('delete from public.placement_history')).rejects.toThrow();
  });

  it('places anyone on a taken spot by moving the member there down, with their team, under the newcomer', async () => {
    const root = await createUser();
    const [a, a1, n, m] = [await createUser(), await createUser(), await createUser(), await createUser()];
    await place(a, root, 'left');
    await place(a1, a, 'left');
    await place(m, n, 'left'); // n already has a left team

    // n takes a's spot; a (with a1) goes to the end of n's left side, under m.
    await place(n, root, 'left');
    const t = (await teamTree(web, root))!;
    expect(t.left[0]?.memberCode).toBe(await code(n));
    expect(t.left[0]?.left[0]?.memberCode).toBe(await code(m));
    expect(t.left[0]?.left[0]?.left[0]?.memberCode).toBe(await code(a));
    expect(t.left[0]?.left[0]?.left[0]?.left[0]?.memberCode).toBe(await code(a1));
    expect(t.leftCount).toBe(4);
    const moved = await one<{ old_parent_id: string; new_parent_id: string; reason: string }>(
      admin,
      'select old_parent_id, new_parent_id, reason from public.placement_history where user_id = $1 order by id desc limit 1',
      [a],
    );
    expect(moved).toMatchObject({ old_parent_id: root, new_parent_id: m });
    expect(moved.reason).toMatch(/^Moved down to make room/);

    // A member inside the occupant's team cannot take the occupant's spot.
    await expect(place(a1, root, 'left')).rejects.toMatchObject({ code: 'not_allowed' });
  });
});

describe('referral bonuses', () => {
  async function fundReferrals(amount: string) {
    await simDeposit(GROUP, usdt(amount), 5, { from: '0x4444444444444444444444444444444444444444' });
    await admin.query('delete from public.network_scan_state');
    const adapter = await simAdapter();
    await ingestNetwork(worker, adapter);
    const d = await one<{ id: string }>(admin, "select id from public.deposits where user_id is null and status in ('detected', 'confirming', 'confirmed') limit 1");
    await withTransaction(worker, (db) => refreshDeposit(db, new SimulatedChainAdapter(adapter.network, db), d.id));
    await withTransaction(worker, (db) => creditDeposit(db, d.id));
    const a = await withTransaction(web, (db) => createAllocation(db, { depositId: d.id, kind: 'referral_fund', reason: 'Referral fund top-up', lines: [], staffUserId: adminId, actor: actor() }));
    await withTransaction(worker, (db) => postAllocation(db, a.id, service));
  }

  it('awards bonuses from the referral fund only, and reversals return the money', async () => {
    const member = await createUser();
    const bonus = (direction: 'credit' | 'debit') =>
      withTransaction(web, (db) => createAdjustment(db, { userId: member, tokenId, direction, amount: '15', reason: 'Bonus for growing the team', fund: 'referral_reward_fund', staffUserId: adminId, actor: actor() }));
    const b = await bonus('credit');
    expect(await withTransaction(worker, (db) => postAdjustment(db, b.id, service))).toBe('deferred'); // empty fund
    await fundReferrals('20');
    expect(await withTransaction(worker, (db) => postAdjustment(db, b.id, service))).toBe('posted');
    expect(await balanceOf('user_cash', tokenId, member)).toBe(usdt('15'));
    expect(await balanceOf('referral_reward_fund', tokenId)).toBe(usdt('5'));
    expect(await balanceOf('operator_float', tokenId)).toBe(0n);
    const ev = await one<{ event_type: string }>(admin, "select event_type from public.journal_entries where source_type = 'manual_adjustment'");
    expect(ev.event_type).toBe('referral_bonus');

    const r = await withTransaction(web, (db) => reverseAdjustment(db, { adjustmentId: b.id, reason: 'Awarded to the wrong member', staffUserId: adminId, actor: actor() }));
    expect(await withTransaction(worker, (db) => postAdjustment(db, r.id, service))).toBe('posted');
    expect(await balanceOf('user_cash', tokenId, member)).toBe(0n);
    expect(await balanceOf('referral_reward_fund', tokenId)).toBe(usdt('20'));
    expect(await checkIntegrity(admin)).toEqual({ unbalancedTokens: [], cacheMismatches: [] });
  });
});

describe('administrator: unlimited members per side', () => {
  it('holds any number of members on each side, on the same level, without displacing anyone', async () => {
    const [a, b, c, d] = [await createUser(), await createUser(), await createUser(), await createUser()];
    await place(a, adminId, 'left');
    await place(b, adminId, 'left');
    await place(c, adminId, 'left');
    await place(d, adminId, 'right');
    const t = (await teamTree(web, adminId))!;
    expect(t.left.map((n) => n.memberCode).sort()).toEqual([await code(a), await code(b), await code(c)].sort());
    expect(t.right.map((n) => n.memberCode)).toEqual([await code(d)]);
    expect([t.leftCount, t.rightCount]).toEqual([3, 1]);
    // Nobody was moved down to make room.
    expect((await admin.query("select count(*)::int as n from public.placement_history where reason like 'Moved down%'")).rows[0].n).toBe(0);
  });

  it('places sign-ups with an administrator’s referral id directly under them', async () => {
    const adminCode = await code(adminId);
    const x = await createUser({ referralCode: adminCode, side: 'left' });
    const y = await createUser({ referralCode: adminCode, side: 'left' });
    const z = await createUser({ referralCode: adminCode, side: 'right' });
    const parents = await admin.query('select user_id, parent_user_id, side from public.binary_placements where user_id = any($1::uuid[])', [[x, y, z]]);
    expect(parents.rows.every((r) => r.parent_user_id === adminId)).toBe(true);
  });

  it('lets the administrator change a member’s level, and keeps one per side for everyone else', async () => {
    const [a, a1, a2] = [await createUser(), await createUser(), await createUser()];
    await place(a, adminId, 'left');
    await place(a1, a, 'left');
    await place(a2, a1, 'left'); // a2 is three levels down
    await place(a2, adminId, 'right'); // moved up to the administrator's own level
    let t = (await teamTree(web, adminId))!;
    expect(t.right.map((n) => n.memberCode)).toEqual([await code(a2)]);
    expect(t.left[0]?.left[0]?.left).toEqual([]);

    // Under a member, a taken spot still moves its occupant down (one per side).
    const n = await createUser();
    await place(n, a, 'left');
    t = (await teamTree(web, adminId))!;
    expect(t.left[0]?.left.map((x) => x.memberCode)).toEqual([await code(n)]);
    expect(t.left[0]?.left[0]?.left[0]?.memberCode).toBe(await code(a1));
    // And the database refuses a second member on a member's side.
    const extra = await createUser();
    await expect(admin.query("insert into public.binary_placements (user_id, parent_user_id, side, placed_by) values ($1, $2, 'left', $3)", [extra, a, adminId])).rejects.toThrow(/taken/);
  });
});
