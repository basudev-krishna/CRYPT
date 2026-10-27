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
  it('places, refuses taken sides and loops, moves whole teams and counts each side', async () => {
    const root = await createUser();
    const [l, r, ll, x] = [await createUser(), await createUser(), await createUser(), await createUser()];
    await place(l, root, 'left');
    await place(r, root, 'right');
    await place(ll, l, 'left');
    await expect(place(x, root, 'left')).rejects.toMatchObject({ code: 'position_taken' });
    await expect(place(root, ll, 'right')).rejects.toMatchObject({ code: 'not_allowed' }); // root under its own team

    let t = (await teamTree(web, root))!;
    expect([t.leftCount, t.rightCount]).toEqual([2, 1]);
    expect(t.left?.left?.memberCode).toBe(await code(ll));

    // Moving l (with ll) under r's right side.
    await place(l, r, 'right');
    t = (await teamTree(web, root))!;
    expect([t.leftCount, t.rightCount]).toEqual([0, 3]);
    expect(t.right?.right?.left?.memberCode).toBe(await code(ll));

    await withTransaction(web, (db) => removePlacement(db, { userId: l, reason: 'Left the group for now', staffUserId: adminId, actor: actor() }));
    t = (await teamTree(web, root))!;
    expect([t.leftCount, t.rightCount]).toEqual([0, 1]);
    expect((await admin.query('select count(*)::int as n from public.placement_history where user_id = $1', [l])).rows[0].n).toBe(3);
    await expect(admin.query('delete from public.placement_history')).rejects.toThrow();
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

  it('awards bonuses from the referral fund only, as credits, and reversals return the money', async () => {
    const member = await createUser();
    const bonus = (direction: 'credit' | 'debit') =>
      withTransaction(web, (db) => createAdjustment(db, { userId: member, tokenId, direction, amount: '15', reason: 'Bonus for growing the team', fund: 'referral_reward_fund', staffUserId: adminId, actor: actor() }));
    await expect(bonus('debit')).rejects.toMatchObject({ code: 'invalid_direction' });
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
