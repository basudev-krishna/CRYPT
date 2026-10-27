/**
 * Referral records and operator-funded referral rewards.
 *
 * A sign-up's referral id becomes a permanent sponsor link; a referral qualifies
 * once the account is approved and has a credited deposit. Rewards are paid only
 * from the referral fund (operator money allocated from a group-wallet receipt),
 * once per referred member, after an administrator approves them.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { admin, balanceOf, closePools, createUser, resetAppData, simAdapter, simDeposit, simToken, usdt, web, worker } from '../helpers/db';
import { one, withTransaction } from '../../src/server/db-core';
import { checkIntegrity } from '../../src/server/ledger/ledger';
import { SimulatedChainAdapter } from '../../src/server/chains/simulated';
import { creditDeposit, ingestNetwork, refreshDeposit } from '../../src/server/deposits/service';
import { createAllocation, postAllocation, type AllocationKind } from '../../src/server/deposits/allocations';
import { getMembership } from '../../src/server/queries/user';
import { adminReferrals } from '../../src/server/queries/admin';
import { detectReferralRewards, postReferralReward, reviewReferralReward, saveReferralPolicy } from '../../src/server/referrals/rewards';
import { DEFAULT_TIERS } from '../../src/server/referrals/rewards';

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
const memberCode = async (userId: string) => (await one<{ member_code: string }>(admin, 'select member_code from public.user_profiles where user_id = $1', [userId])).member_code;

/** An unattributed group-wallet receipt, received into suspense. */
async function receipt(amount: string) {
  await simDeposit(GROUP, usdt(amount), 5, { from: '0x4444444444444444444444444444444444444444' });
  // The transfer lands a few blocks back; rescan so a second receipt in one test is seen too (ingest is idempotent).
  await admin.query('delete from public.network_scan_state');
  const adapter = await simAdapter();
  await ingestNetwork(worker, adapter);
  const d = await one<{ id: string }>(admin, "select id from public.deposits where user_id is null and status in ('detected', 'confirming', 'confirmed') limit 1");
  await withTransaction(worker, (db) => refreshDeposit(db, new SimulatedChainAdapter(adapter.network, db), d.id));
  await withTransaction(worker, (db) => creditDeposit(db, d.id));
  return d.id;
}

async function allocate(depositId: string, kind: AllocationKind, lines: { userId: string; amount: string }[]) {
  const a = await withTransaction(web, (db) => createAllocation(db, { depositId, kind, reason: 'Referral test allocation', lines, staffUserId: adminId, actor: staff() }));
  expect(await withTransaction(worker, (db) => postAllocation(db, a.id, service))).toBe('posted');
}

/** Credits `amount` to `userId` the group-mode way: an unattributed receipt assigned by an admin. */
const credit = async (userId: string, amount: string) => allocate(await receipt(amount), 'assignment', [{ userId, amount }]);

const enable = (reward_amount = '10') =>
  withTransaction(web, (db) =>
    saveReferralPolicy(db, staff(), { enabled: true, reward_amount, program_start: '2000-01-01T00:00:00.000Z', tiers: DEFAULT_TIERS }, 'Start the referral program'),
  );
const detect = () => withTransaction(worker, (db) => detectReferralRewards(db));
const review = (rewardId: string, decision: 'approve' | 'reject', staffUserId = adminId) =>
  withTransaction(web, (db) => reviewReferralReward(db, { rewardId, decision, note: 'Checked the referral by hand', staffUserId, actor: { type: 'staff', id: staffUserId } }));
const post = (id: string) => withTransaction(worker, (db) => postReferralReward(db, id, service));
const rewardFor = (referred: string) => one<{ id: string; status: string; amount_base: string; error: string | null }>(
  admin,
  'select id, status, amount_base::text, error from public.referral_rewards where referred_user_id = $1',
  [referred],
);
const clean = { unbalancedTokens: [], cacheMismatches: [] };

describe('referrals', () => {
  it('records the referrer permanently and tracks each referral stage', async () => {
    const sponsor = await createUser();
    const code = await memberCode(sponsor);
    const pending = await createUser({ referralCode: code.toLowerCase(), status: 'pending_approval' });
    const joined = await createUser({ referralCode: code });
    const funded = await createUser({ referralCode: code });
    const unrelated = await createUser({ referralCode: 'EW-999999' });
    await credit(funded, '100');

    const m = await getMembership(web, sponsor);
    const stages = Object.fromEntries(m!.sponsored.map((s) => [s.memberCode, s.stage]));
    expect(stages).toEqual({
      [await memberCode(pending)]: 'awaiting_approval',
      [await memberCode(joined)]: 'joined',
      [await memberCode(funded)]: 'qualified',
    });
    expect((await getMembership(web, funded))!.sponsorMemberCode).toBe(code);
    expect((await getMembership(web, unrelated))!.sponsorMemberCode).toBeNull();

    const all = await adminReferrals(web);
    expect(all).toHaveLength(3);
    expect(all.find((r) => r.userId === funded)).toMatchObject({ stage: 'qualified', sponsorMemberCode: code, firstCreditedAt: expect.any(Date) });

    // The sponsor link can't be rewritten afterwards, not even by the owner role.
    await expect(admin.query('update public.user_profiles set sponsor_user_id = null where user_id = $1', [funded])).rejects.toThrow(/permanent/);
  });
});

describe('operator-funded referral rewards', () => {
  it('records nothing until the program is switched on', async () => {
    const sponsor = await createUser();
    const referred = await createUser({ referralCode: await memberCode(sponsor) });
    await credit(referred, '50');
    expect(await detect()).toBe(0);
    await enable();
    expect(await detect()).toBe(1);
    expect(await detect()).toBe(0); // one reward per referred member
    expect(await rewardFor(referred)).toMatchObject({ status: 'pending', amount_base: usdt('10').toString() });
  });

  it('pays an approved reward from the fund only, exactly once, and never more than was funded', async () => {
    const sponsor = await createUser();
    const referred = await createUser({ referralCode: await memberCode(sponsor) });
    await credit(referred, '200');
    await enable('10');
    await detect();
    const r = await rewardFor(referred);

    // Pending: not on the ledger, so nothing to withdraw.
    expect(await post(r.id)).toBe('unchanged');
    expect(await balanceOf('user_cash', tokenId, sponsor)).toBe(0n);

    await review(r.id, 'approve');
    // Empty fund: held with a reason, never paid from members' money.
    expect(await post(r.id)).toBe('deferred');
    expect((await rewardFor(referred)).error).toMatch(/fund is too low/);
    expect(await balanceOf('user_cash', tokenId, sponsor)).toBe(0n);

    // The operator funds 25 USDT from a group-wallet receipt.
    await allocate(await receipt('25'), 'referral_fund', []);
    expect(await balanceOf('referral_reward_fund', tokenId)).toBe(usdt('25'));

    expect(await post(r.id)).toBe('posted');
    expect(await post(r.id)).toBe('unchanged');
    expect(await balanceOf('user_cash', tokenId, sponsor)).toBe(usdt('10'));
    expect(await balanceOf('referral_reward_fund', tokenId)).toBe(usdt('15'));
    expect(await balanceOf('user_cash', tokenId, referred)).toBe(usdt('200')); // untouched
    expect(await checkIntegrity(admin)).toEqual(clean);
  });

  it('holds approved rewards the fund cannot cover', async () => {
    const sponsor = await createUser();
    const code = await memberCode(sponsor);
    const a = await createUser({ referralCode: code });
    const b = await createUser({ referralCode: code });
    await credit(a, '100');
    await credit(b, '100');
    await allocate(await receipt('15'), 'referral_fund', []);
    await enable('10');
    await detect();
    const ra = await rewardFor(a);
    const rb = await rewardFor(b);
    await review(ra.id, 'approve');
    await review(rb.id, 'approve');
    const outcomes = [await post(ra.id), await post(rb.id)].sort();
    expect(outcomes).toEqual(['deferred', 'posted']);
    expect(await balanceOf('user_cash', tokenId, sponsor)).toBe(usdt('10'));
    expect(await balanceOf('referral_reward_fund', tokenId)).toBe(usdt('5'));
    expect(await checkIntegrity(admin)).toEqual(clean);
  });

  it('enforces review rules and a final rejection', async () => {
    const second = await createUser();
    await admin.query("insert into public.staff_roles (user_id, role) values ($1, 'admin')", [second]);
    // The first admin referred someone: with a second admin around, they may not decide their own reward.
    const referred = await createUser({ referralCode: await memberCode(adminId) });
    await credit(referred, '100');
    await enable();
    await detect();
    const r = await rewardFor(referred);
    await expect(review(r.id, 'approve', adminId)).rejects.toMatchObject({ code: 'conflict_of_interest' });
    await review(r.id, 'reject', second);
    await expect(review(r.id, 'approve', second)).rejects.toMatchObject({ code: 'invalid_state' });
    await detect();
    expect(await rewardFor(referred)).toMatchObject({ status: 'rejected' }); // no second reward for the same member
  });

  it('keeps the web role away from reward amounts and payment', async () => {
    const sponsor = await createUser();
    const referred = await createUser({ referralCode: await memberCode(sponsor) });
    await credit(referred, '100');
    await enable();
    await detect();
    const r = await rewardFor(referred);
    await expect(web.query('update public.referral_rewards set amount_base = 1 where id = $1', [r.id])).rejects.toThrow(/permission denied/);
    await expect(web.query("update public.referral_rewards set status = 'posted' where id = $1", [r.id])).rejects.toThrow();
    await expect(
      web.query('insert into public.referral_rewards (referred_user_id, sponsor_user_id, token_id, amount_base, policy_version_id, qualified_at) select $1, $2, $3, 1, id, now() from public.policy_versions limit 1', [
        sponsor,
        referred,
        tokenId,
      ]),
    ).rejects.toThrow(/permission denied/);
    await expect(web.query('delete from public.referral_rewards where id = $1', [r.id])).rejects.toThrow();
  });
});
