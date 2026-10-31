/**
 * Fixed daily returns: a contractual daily accrual on principal, paid only from
 * recorded business revenue (docs/daily-returns.md).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { admin, balanceOf, closePools, createUser, resetAppData, simAdapter, simDeposit, simToken, usdt, web, worker } from '../helpers/db';
import { one, withTransaction } from '../../src/server/db-core';
import { checkIntegrity } from '../../src/server/ledger/ledger';
import { SimulatedChainAdapter } from '../../src/server/chains/simulated';
import { creditDeposit, ingestNetwork, refreshDeposit } from '../../src/server/deposits/service';
import { createAllocation, postAllocation } from '../../src/server/deposits/allocations';
import {
  accrueSubscription,
  activatePlan,
  cancelSubscription,
  closePlan,
  createPlan,
  matureAccruals,
  obligationInvariant,
  openSubscription,
  redeemSubscription,
  requestRedemption,
  requestSubscription,
  listRevenueRecords,
  returnsOverview,
  settlePayables,
} from '../../src/server/returns/service';
import { postOfflinePayment, recordOfflinePayment, recordOfflineSubscription, requestOfflineRedemption } from '../../src/server/returns/offline';
import { memberReturns } from '../../src/server/returns/service';
import { enrollDeposits } from '../../src/server/returns/enroll';
import { addFundingWallet, recordFundingReceipts, removeFundingWallet } from '../../src/server/returns/funding';
import { simNetwork } from '../helpers/db';

const GROUP = '0x0000000000000000000000000000000000000a07';
const REVENUE_SENDER = '0x7777777777777777777777777777777777777777';
const DAY = 86_400_000;
const service = { type: 'service' as const, id: 'test' };
const clean = { unbalancedTokens: [], cacheMismatches: [] };
let adminId: string;
let tokenId: number;
let receipts = 0;

beforeEach(async () => {
  await resetAppData();
  await admin.query('update public.treasury_wallets set receives_deposits = true where address = $1', [GROUP]);
  tokenId = (await simToken()).id;
  adminId = await createUser();
  await admin.query("insert into public.staff_roles (user_id, role) values ($1, 'admin')", [adminId]);
});
afterAll(closePools);

const actor = () => ({ type: 'staff' as const, id: adminId });
const later = (days: number) => new Date(Date.now() + days * DAY);
const count = async (sql: string, params: unknown[] = []) => (await one<{ n: number }>(admin, sql, params)).n;

/** A group-wallet receipt from `from`, received into suspense and ready to allocate. */
async function receipt(amount: string, from: string): Promise<string> {
  receipts++;
  await simDeposit(GROUP, usdt(amount), 5, { from });
  await admin.query('delete from public.network_scan_state');
  const adapter = await simAdapter();
  await ingestNetwork(worker, adapter);
  const d = await one<{ id: string }>(admin, "select id from public.deposits where user_id is null and status in ('detected', 'confirming', 'confirmed')");
  await withTransaction(worker, (db) => refreshDeposit(db, new SimulatedChainAdapter(adapter.network, db), d.id));
  await withTransaction(worker, (db) => creditDeposit(db, d.id));
  return d.id;
}

/** A member's own deposit, assigned to them (their sender address becomes a known member sender). */
async function fundMember(member: string, amount: string, from = `0x${String(5000 + receipts).padStart(40, '5')}`) {
  const depositId = await receipt(amount, from);
  const a = await withTransaction(web, (db) => createAllocation(db, { depositId, kind: 'assignment', reason: 'Member deposit from own wallet', lines: [{ userId: member, amount }], staffUserId: adminId, actor: actor() }));
  expect(await withTransaction(worker, (db) => postAllocation(db, a.id, service))).toBe('posted');
  return from;
}

const revenueDetails = { businessLine: 'Trading desk A', periodStart: '2026-10-01', periodEnd: '2026-10-31', evidenceReference: 'INV-2026-10-001' };

async function recordRevenue(amount: string, from = REVENUE_SENDER) {
  const depositId = await receipt(amount, from);
  const a = await withTransaction(web, (db) =>
    createAllocation(db, { depositId, kind: 'business_revenue', reason: 'October revenue from desk A', lines: [], revenue: revenueDetails, staffUserId: adminId, actor: actor() }),
  );
  expect(await withTransaction(worker, (db) => postAllocation(db, a.id, service))).toBe('posted');
}

async function activePlan(opts: { lockDays?: number; payableAfterDays?: number; termDays?: number | null } = {}) {
  const { id } = await withTransaction(web, (db) =>
    createPlan(db, {
      name: 'Plan 0.33',
      tokenId,
      dailyRatePpm: 3300,
      minPrincipal: '10',
      termDays: opts.termDays ?? null,
      payableAfterDays: opts.payableAfterDays ?? 0,
      principalLockDays: opts.lockDays ?? 30,
      termsReference: 'Terms v1 signed 2026-10-30',
      staffUserId: adminId,
      actor: actor(),
    }),
  );
  await withTransaction(web, (db) => activatePlan(db, { planId: id, note: 'Approved by the board', staffUserId: adminId, actor: actor() }));
  return id;
}

async function subscribe(member: string, planId: string, amount: string) {
  const key = `k${Math.random().toString(36).slice(2)}${Date.now()}`.padEnd(20, 'x');
  const { id } = await withTransaction(web, (db) => requestSubscription(db, { userId: member, planId, amount, clientKey: key, actor: { type: 'user', id: member } }));
  return { id, key };
}

const open = (id: string) => withTransaction(worker, (db) => openSubscription(db, id, service));
const accrue = (id: string, now: Date) => withTransaction(worker, (db) => accrueSubscription(db, id, service, now));
const mature = (now: Date) => withTransaction(worker, (db) => matureAccruals(db, service, now));
const settle = (now: Date = new Date()) => withTransaction(worker, (db) => settlePayables(db, tokenId, service, now));

describe('plans', () => {
  it('keeps terms immutable and needs a second administrator to activate, unless sole admin (alerted)', async () => {
    const { id } = await withTransaction(web, (db) =>
      createPlan(db, { name: 'Draft', tokenId, dailyRatePpm: 3300, minPrincipal: '10', termDays: 365, payableAfterDays: 0, principalLockDays: 30, termsReference: 'Terms v1', staffUserId: adminId, actor: actor() }),
    );
    // The web role has no grant on terms at all; even the table owner is stopped by the trigger.
    await expect(web.query('update public.return_plans set daily_rate_ppm = 5000 where id = $1', [id])).rejects.toThrow(/permission denied/);
    await expect(admin.query('update public.return_plans set daily_rate_ppm = 5000 where id = $1', [id])).rejects.toThrow(/immutable/);

    const second = await createUser();
    await admin.query("insert into public.staff_roles (user_id, role) values ($1, 'admin')", [second]);
    await expect(withTransaction(web, (db) => activatePlan(db, { planId: id, note: 'Approving my own plan', staffUserId: adminId, actor: actor() }))).rejects.toMatchObject({ code: 'four_eyes_required' });
    await withTransaction(web, (db) => activatePlan(db, { planId: id, note: 'Second admin approves', staffUserId: second, actor: { type: 'staff', id: second } }));
    expect(await count("select count(*)::int as n from public.risk_events where kind = 'return_plan_activated' and severity = 'high'")).toBe(1);

    await admin.query('delete from public.staff_roles where user_id = $1', [second]);
    await activePlan();
    expect(await count("select count(*)::int as n from public.risk_events where kind = 'admin_self_plan_activation' and severity = 'high'")).toBe(1);
  });

  it('refuses a minimum that would accrue nothing per day', async () => {
    await expect(
      withTransaction(web, (db) =>
        createPlan(db, { name: 'Tiny', tokenId, dailyRatePpm: 3300, minPrincipal: '0.0001', termDays: null, payableAfterDays: 0, principalLockDays: 0, termsReference: 'Terms v1', staffUserId: adminId, actor: actor() }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_minimum' });
  });

  it('a closed plan takes no new subscriptions and fails requests not yet opened', async () => {
    const member = await createUser();
    await fundMember(member, '100');
    const planId = await activePlan();
    const { id } = await subscribe(member, planId, '50');
    await withTransaction(web, (db) => closePlan(db, { planId, note: 'Closing to new money', staffUserId: adminId, actor: actor() }));
    expect(await open(id)).toBe('failed');
    await expect(subscribe(member, planId, '50')).rejects.toMatchObject({ code: 'plan_not_active' });
    expect(await balanceOf('user_cash', tokenId, member)).toBe(usdt('100'));
  });
});

describe('subscriptions', () => {
  it('moves principal under the balance lock, exactly once, and retries harmlessly', async () => {
    const member = await createUser();
    await fundMember(member, '1000');
    const planId = await activePlan();
    const { id, key } = await subscribe(member, planId, '1000');
    // Same key, same request: the same subscription. Same key, different amount: refused.
    const again = await withTransaction(web, (db) => requestSubscription(db, { userId: member, planId, amount: '1000', clientKey: key, actor: { type: 'user', id: member } }));
    expect(again.id).toBe(id);
    await expect(withTransaction(web, (db) => requestSubscription(db, { userId: member, planId, amount: '999', clientKey: key, actor: { type: 'user', id: member } }))).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });

    expect(await open(id)).toBe('posted');
    expect(await open(id)).toBe('unchanged');
    expect(await balanceOf('user_cash', tokenId, member)).toBe(0n);
    expect(await balanceOf('plan_principal', tokenId, member)).toBe(usdt('1000'));

    // A second request the balance can no longer cover fails instead of going negative.
    const { id: tooMuch } = await subscribe(member, planId, '10');
    expect(await open(tooMuch)).toBe('failed');
    expect(await checkIntegrity(admin)).toEqual(clean);
  });

  it('lets a member cancel only a pending request, and the web role cannot open one itself', async () => {
    const member = await createUser();
    await fundMember(member, '100');
    const planId = await activePlan();
    const { id } = await subscribe(member, planId, '50');
    await expect(web.query("update public.plan_subscriptions set status = 'active' where id = $1", [id])).rejects.toThrow();
    await withTransaction(web, (db) => cancelSubscription(db, { userId: member, subscriptionId: id, actor: { type: 'user', id: member } }));
    expect(await open(id)).toBe('unchanged');
    expect(await balanceOf('user_cash', tokenId, member)).toBe(usdt('100'));
  });
});

describe('daily accrual', () => {
  it('accrues 0.33% per finished UTC day, reproducibly, and never twice', async () => {
    const member = await createUser();
    await fundMember(member, '1000');
    const planId = await activePlan();
    const { id } = await subscribe(member, planId, '1000');
    await open(id);

    expect(await accrue(id, new Date())).toBe(0); // the opening day is not accrued
    expect(await accrue(id, later(3))).toBe(3); // days +1, +2, +3 (each accrues as it starts)
    expect(await accrue(id, later(3))).toBe(0);
    expect(await balanceOf('return_accrued', tokenId, member)).toBe(usdt('9.9'));
    expect(await balanceOf('return_cost', tokenId)).toBe(usdt('9.9'));
    expect(await balanceOf('user_cash', tokenId, member)).toBe(0n); // a promise, not money

    const rows = await admin.query(
      "select principal_base::text as p, daily_rate_ppm as r, amount_base::text as a, accrual_entry_id from public.return_accruals where subscription_id = $1 order by accrual_date",
      [id],
    );
    expect(rows.rows).toHaveLength(3);
    for (const r of rows.rows) {
      expect([r.p, r.r, r.a]).toEqual([usdt('1000').toString(), 3300, usdt('3.3').toString()]);
      expect(r.accrual_entry_id).not.toBeNull();
    }
    // The formula is enforced by the database.
    await expect(admin.query('update public.return_accruals set amount_base = amount_base + 1 where subscription_id = $1', [id])).rejects.toThrow();
    expect(await obligationInvariant(admin, tokenId)).toMatchObject({ ok: true });
    expect(await checkIntegrity(admin)).toEqual(clean);
  });

  it('pauses accrual without losing days, and stops at the term end', async () => {
    const member = await createUser();
    await fundMember(member, '1000');
    const planId = await activePlan({ termDays: 5 });
    const { id } = await subscribe(member, planId, '1000');
    await open(id);

    await admin.query("update public.system_controls set enabled = true where key = 'return_accruals_paused'");
    expect(await accrue(id, later(3))).toBe(0);
    await admin.query("update public.system_controls set enabled = false where key = 'return_accruals_paused'");
    expect(await accrue(id, later(3))).toBe(3); // caught up
    expect(await accrue(id, later(30))).toBe(2); // term of 5 days, then nothing more
    expect(await accrue(id, later(60))).toBe(0);
    expect(await count('select count(*)::int as n from public.return_accruals where subscription_id = $1', [id])).toBe(5);
  });
});

describe('settlement from business revenue only', () => {
  it('holds due returns until revenue arrives, then pays oldest first in whole amounts', async () => {
    const member = await createUser();
    await fundMember(member, '1000');
    const planId = await activePlan();
    const { id } = await subscribe(member, planId, '1000');
    await open(id);
    await accrue(id, later(3));

    // Not due yet on the accrual day itself, due the next day (payable_after_days = 0).
    expect(await mature(later(1))).toBe(0);
    expect(await mature(later(4))).toBe(3);
    expect(await balanceOf('return_payable', tokenId, member)).toBe(usdt('9.9'));

    // No revenue: nothing is paid, a shortfall is raised once per day.
    expect(await settle()).toMatchObject({ settled: 0, held: 'shortfall' });
    expect(await settle()).toMatchObject({ settled: 0, held: 'shortfall' });
    expect(await count("select count(*)::int as n from public.risk_events where kind = 'return_reserve_shortfall'")).toBe(1);
    expect(await balanceOf('user_cash', tokenId, member)).toBe(0n);

    await recordRevenue('5');
    expect(await settle()).toMatchObject({ settled: 1, total: usdt('3.3'), held: 'shortfall' });
    expect(await balanceOf('user_cash', tokenId, member)).toBe(usdt('3.3'));
    expect(await balanceOf('return_reserve', tokenId)).toBe(usdt('1.7'));
    expect(await balanceOf('return_payable', tokenId, member)).toBe(usdt('6.6'));
    expect(await balanceOf('plan_principal', tokenId, member)).toBe(usdt('1000')); // principal never touched

    await recordRevenue('100');
    expect(await settle()).toMatchObject({ settled: 2, held: null });
    expect(await settle()).toMatchObject({ settled: 0, held: null });
    expect(await balanceOf('user_cash', tokenId, member)).toBe(usdt('9.9'));
    expect(await balanceOf('return_cost', tokenId)).toBe(0n);

    const [o] = await returnsOverview(admin);
    const revenue = await listRevenueRecords(admin);
    expect(revenue.map((r) => [r.business_line, r.from_address.toLowerCase(), r.status])).toEqual([
      ['Trading desk A', REVENUE_SENDER, 'posted'],
      ['Trading desk A', REVENUE_SENDER, 'posted'],
    ]);
    expect(o).toMatchObject({ principal: usdt('1000'), accrued: 0n, payable: 0n, settledToDate: usdt('9.9'), revenueToDate: usdt('105'), dailyRunRate: usdt('3.3'), invariantOk: true });
    expect(await obligationInvariant(admin, tokenId)).toMatchObject({ ok: true });
    expect(await checkIntegrity(admin)).toEqual(clean);
  });

  it('pays nothing while settlements are paused', async () => {
    const member = await createUser();
    await fundMember(member, '1000');
    const { id } = await subscribe(member, await activePlan(), '1000');
    await open(id);
    await accrue(id, later(2));
    await mature(later(2));
    await recordRevenue('100');
    await admin.query("update public.system_controls set enabled = true where key = 'return_settlements_paused'");
    expect(await settle()).toMatchObject({ settled: 0, held: 'paused' });
    await admin.query("update public.system_controls set enabled = false where key = 'return_settlements_paused'");
    expect(await settle()).toMatchObject({ settled: 1 });
  });

  it('skips a frozen member without blocking others', async () => {
    const a = await createUser();
    const b = await createUser();
    await fundMember(a, '1000');
    await fundMember(b, '1000');
    const planId = await activePlan();
    const sa = await subscribe(a, planId, '1000');
    await open(sa.id);
    const sb = await subscribe(b, planId, '1000');
    await open(sb.id);
    await accrue(sa.id, later(2));
    await accrue(sb.id, later(2));
    await mature(later(2));
    await recordRevenue('100');
    await admin.query("update public.user_profiles set account_status = 'frozen' where user_id = $1", [a]);
    expect(await settle()).toMatchObject({ settled: 1 });
    expect(await balanceOf('return_payable', tokenId, a)).toBe(usdt('3.3'));
    expect(await balanceOf('user_cash', tokenId, b)).toBe(usdt('3.3'));
  });

  it('refuses to record a member’s money as revenue, and requires revenue details', async () => {
    const member = await createUser();
    const memberSender = await fundMember(member, '100');
    const depositId = await receipt('50', memberSender);
    await expect(
      withTransaction(web, (db) => createAllocation(db, { depositId, kind: 'business_revenue', reason: 'Not really revenue here', lines: [], revenue: revenueDetails, staffUserId: adminId, actor: actor() })),
    ).rejects.toMatchObject({ code: 'revenue_from_member' });

    const other = await receipt('50', REVENUE_SENDER);
    await expect(
      withTransaction(web, (db) => createAllocation(db, { depositId: other, kind: 'business_revenue', reason: 'Revenue without details', lines: [], staffUserId: adminId, actor: actor() })),
    ).rejects.toMatchObject({ code: 'revenue_details_required' });
    expect(await balanceOf('return_reserve', tokenId)).toBe(0n);
  });
});

describe('principal redemption', () => {
  it('is refused during the lock', async () => {
    const member = await createUser();
    await fundMember(member, '100');
    const { id } = await subscribe(member, await activePlan({ lockDays: 30 }), '100');
    await open(id);
    await expect(withTransaction(web, (db) => requestRedemption(db, { userId: member, subscriptionId: id, actor: { type: 'user', id: member } }))).rejects.toMatchObject({
      code: 'principal_locked',
    });
    // The database refuses it too, even if the service check were bypassed.
    await expect(web.query("update public.plan_subscriptions set status = 'redeem_requested', redeem_requested_at = now() where id = $1", [id])).rejects.toThrow(/locked/);
  });

  it('returns principal after the lock and stops accrual after the request day', async () => {
    const member = await createUser();
    await fundMember(member, '1000');
    const planId = await activePlan({ lockDays: 0 });
    const { id } = await subscribe(member, planId, '1000');
    await open(id);
    await withTransaction(web, (db) => requestRedemption(db, { userId: member, subscriptionId: id, actor: { type: 'user', id: member } }));
    expect(await withTransaction(worker, (db) => redeemSubscription(db, id, service))).toBe('posted');
    expect(await withTransaction(worker, (db) => redeemSubscription(db, id, service))).toBe('unchanged');
    expect(await balanceOf('plan_principal', tokenId, member)).toBe(0n);
    expect(await balanceOf('user_cash', tokenId, member)).toBe(usdt('1000'));
    expect(await accrue(id, later(10))).toBe(0); // redeemed on the opening day: no day accrued
    expect(await checkIntegrity(admin)).toEqual(clean);
  });
});

describe('company funding wallets', () => {
  const TEAM = '0x8888888888888888888888888888888888888888';
  const addTeamWallet = async (address = TEAM) => {
    const net = await simNetwork(admin);
    return withTransaction(web, (db) => addFundingWallet(db, { networkId: net.id, address, label: 'Finance team wallet', staffUserId: adminId, actor: actor() }));
  };
  const recordFunding = () => withTransaction(worker, (db) => recordFundingReceipts(db, service));

  it('records the team’s daily transfers as funding automatically and credits members’ balances', async () => {
    const member = await createUser();
    await fundMember(member, '1000');
    const { id } = await subscribe(member, await activePlan(), '1000');
    await open(id);
    await addTeamWallet();
    expect(await count("select count(*)::int as n from public.risk_events where kind = 'return_funding_wallet_added' and severity = 'high'")).toBe(1);

    await accrue(id, later(2));
    await mature(later(2));
    await receipt('3.3', TEAM); // the team sends the day's funding
    expect(await recordFunding()).toBe(1);
    expect(await recordFunding()).toBe(0); // idempotent
    expect(await balanceOf('return_reserve', tokenId)).toBe(usdt('3.3'));
    expect(await settle()).toMatchObject({ settled: 1, held: null });
    expect(await balanceOf('user_cash', tokenId, member)).toBe(usdt('3.3'));

    const rec = await one<{ business_line: string; evidence_reference: string }>(admin, 'select business_line, evidence_reference from public.business_revenue_records');
    expect(rec.business_line).toBe('Finance team wallet');
    expect(rec.evidence_reference).toMatch(/^On-chain transfer /);
    expect(await checkIntegrity(admin)).toEqual(clean);
  });

  it('ignores receipts from other senders and from removed wallets', async () => {
    const w = await addTeamWallet();
    await receipt('10', REVENUE_SENDER);
    expect(await recordFunding()).toBe(0);
    await withTransaction(web, (db) => removeFundingWallet(db, { walletId: w.id, note: 'Wallet retired by finance', staffUserId: adminId, actor: actor() }));
    await receipt('10', TEAM);
    expect(await recordFunding()).toBe(0);
    expect(await balanceOf('return_reserve', tokenId)).toBe(0n);
  });

  it('never accepts a member’s wallet, in either direction, and the worker may record nothing else', async () => {
    const member = await createUser();
    const memberSender = await fundMember(member, '100');
    await expect(addTeamWallet(memberSender)).rejects.toMatchObject({ code: 'funding_wallet_refused' });

    await addTeamWallet();
    const net = await simNetwork(admin);
    await expect(
      admin.query("insert into public.member_wallets (user_id, network_id, address, proof_message, proof_signature) values ($1, $2, $3, 'm', 's')", [member, net.id, TEAM]),
    ).rejects.toThrow(/company funding wallet/);

    const depositId = await receipt('5', REVENUE_SENDER);
    await expect(worker.query("insert into public.allocations (deposit_id, kind, reason, created_by) values ($1, 'business_revenue', 'not from a funding wallet', $2)", [depositId, adminId])).rejects.toThrow(
      /funding wallet/,
    );
    await expect(worker.query("insert into public.allocations (deposit_id, kind, reason, created_by) values ($1, 'operator_float', 'worker cannot do this', $2)", [depositId, adminId])).rejects.toThrow();
  });
});

describe('principal and payments settled offline', () => {
  const offlineSub = (member: string, planId: string, amount = '1000') =>
    withTransaction(web, (db) => recordOfflineSubscription(db, { userId: member, planId, amount, reference: 'Cash to Ravi, 30 Oct', staffUserId: adminId, actor: actor() }));
  const payOffline = (member: string, throughDate: string, now?: Date) =>
    withTransaction(web, (db) => recordOfflinePayment(db, { userId: member, tokenId, throughDate, note: 'Paid in cash by the team', staffUserId: adminId, actor: actor(), now }));
  const postPayment = (id: string) => withTransaction(worker, (db) => postOfflinePayment(db, id, service));

  it('accrues on offline principal, shows it, and never makes it withdrawable', async () => {
    const member = await createUser();
    const planId = await activePlan();
    const { id } = await offlineSub(member, planId);
    expect(await count("select count(*)::int as n from public.risk_events where kind = 'offline_subscription_recorded' and severity = 'high'")).toBe(1);
    expect(await open(id)).toBe('posted');
    expect(await balanceOf('plan_principal', tokenId, member)).toBe(0n); // off the ledger: no wallet money backs it
    expect(await accrue(id, later(2))).toBe(2);
    expect(await balanceOf('return_accrued', tokenId, member)).toBe(usdt('6.6'));
    expect(await balanceOf('user_cash', tokenId, member)).toBe(0n);

    const { totals } = await memberReturns(admin, member);
    expect(totals[0]).toMatchObject({ principal: '0', offline_principal: usdt('1000').toString(), accrued: usdt('6.6').toString() });
    expect(await checkIntegrity(admin)).toEqual(clean);
  });

  it('is paid offline by the team, never from the on-chain reserve, and only once', async () => {
    const member = await createUser();
    const { id } = await offlineSub(member, await activePlan());
    await open(id);
    await accrue(id, later(3)); // days +1, +2, +3
    await mature(later(4));
    await recordRevenue('100'); // there is on-chain funding, but offline plans never draw on it
    expect(await settle()).toMatchObject({ settled: 0 });
    expect(await balanceOf('return_payable', tokenId, member)).toBe(usdt('9.9'));

    // The team pays the first two days offline.
    const throughDay2 = later(2).toISOString().slice(0, 10);
    const payment = await payOffline(member, throughDay2, later(4));
    expect(await count("select count(*)::int as n from public.risk_events where kind = 'offline_return_payment_self' or kind = 'offline_return_payment'")).toBe(1);
    expect(await postPayment(payment.id)).toBe('posted');
    expect(await postPayment(payment.id)).toBe('unchanged');
    expect(await balanceOf('return_payable', tokenId, member)).toBe(usdt('3.3'));
    expect(await balanceOf('user_cash', tokenId, member)).toBe(0n); // paid outside the platform: nothing withdrawable here
    expect(await balanceOf('return_reserve', tokenId)).toBe(usdt('100'));
    const p = await one<{ status: string; amount_base: string; accruals: number }>(admin, 'select status, amount_base::text, accruals from public.offline_return_payments where id = $1', [payment.id]);
    expect(p).toMatchObject({ status: 'posted', amount_base: usdt('6.6').toString(), accruals: 2 });

    // The same days can't be paid again; a later payment covers only what is still due.
    await expect(payOffline(member, throughDay2, later(4))).rejects.toMatchObject({ code: 'nothing_due' });
    const rest = await payOffline(member, later(3).toISOString().slice(0, 10), later(4));
    expect(await postPayment(rest.id)).toBe('posted');
    expect(await balanceOf('return_payable', tokenId, member)).toBe(0n);

    const { totals, accruals } = await memberReturns(admin, member);
    expect(totals[0]).toMatchObject({ paid_offline: usdt('9.9').toString(), settled: '0', payable: '0' });
    expect(accruals.every((a) => a.paid_offline)).toBe(true);
    expect(await obligationInvariant(admin, tokenId)).toMatchObject({ ok: true });
    expect(await checkIntegrity(admin)).toEqual(clean);
  });

  it('refuses future dates, and the team returns offline principal offline', async () => {
    const member = await createUser();
    const { id } = await offlineSub(member, await activePlan({ lockDays: 0 }));
    await open(id);
    await expect(payOffline(member, later(5).toISOString().slice(0, 10))).rejects.toMatchObject({ code: 'invalid_date' });
    // The member can't redeem an offline plan through the platform; the team records it.
    await expect(withTransaction(web, (db) => requestRedemption(db, { userId: member, subscriptionId: id, actor: { type: 'user', id: member } }))).rejects.toMatchObject({
      code: 'returned_offline',
    });
    await withTransaction(web, (db) => requestOfflineRedemption(db, { subscriptionId: id, note: 'Returned in cash by the team', staffUserId: adminId, actor: actor() }));
    expect(await withTransaction(worker, (db) => redeemSubscription(db, id, service))).toBe('posted');
    const s = await one<{ status: string; redeem_entry_id: string | null }>(admin, 'select status, redeem_entry_id from public.plan_subscriptions where id = $1', [id]);
    expect(s).toEqual({ status: 'redeemed', redeem_entry_id: null });
    expect(await balanceOf('user_cash', tokenId, member)).toBe(0n);
    expect(await accrue(id, later(10))).toBe(0);
    expect(await checkIntegrity(admin)).toEqual(clean);
  });
});

describe('automatic enrolment of deposits', () => {
  const enroll = () => withTransaction(worker, (db) => enrollDeposits(db, service));
  const yesterday = () => new Date(Date.now() - DAY).toISOString().slice(0, 10);

  async function autoPlan() {
    const { id } = await withTransaction(web, (db) =>
      createPlan(db, { name: 'Auto 0.33', tokenId, dailyRatePpm: 3300, minPrincipal: '10', termDays: null, payableAfterDays: 0, principalLockDays: 0, termsReference: 'Terms v1', autoEnroll: true, staffUserId: adminId, actor: actor() }),
    );
    await withTransaction(web, (db) => activatePlan(db, { planId: id, note: 'Approved by the board', staffUserId: adminId, actor: actor() }));
    return id;
  }

  /** Pretend a deposit's ledger entry was posted yesterday (test-only: bypasses the immutability trigger). */
  async function backdateDeposits(member: string) {
    await admin.query(
      `begin; set local session_replication_role = replica;
       update public.journal_entries e set posted_at = now() - interval '1 day'
        where exists (select 1 from public.journal_lines l join public.ledger_accounts a on a.id = l.account_id
                       where l.entry_id = e.id and a.user_id = '${member}' and a.purpose = 'user_cash');
       commit;`,
    );
  }

  it('enrols existing deposits when the plan is activated: yesterday’s deposit earns from today, never before the plan', async () => {
    const member = await createUser();
    await fundMember(member, '1000');
    await backdateDeposits(member);
    const planId = await autoPlan();

    expect(await enroll()).toBe(1);
    expect(await enroll()).toBe(0); // each deposit once
    const sub = await one<{ id: string }>(admin, 'select id from public.plan_subscriptions where user_id = $1 and plan_id = $2', [member, planId]);
    expect(await open(sub.id)).toBe('posted');
    expect(await balanceOf('user_cash', tokenId, member)).toBe(0n);
    expect(await balanceOf('plan_principal', tokenId, member)).toBe(usdt('1000'));

    const start = await one<{ d: string }>(admin, "select to_char(accrual_start_date, 'YYYY-MM-DD') as d from public.plan_subscriptions where id = $1", [sub.id]);
    expect(start.d).toBe(new Date().toISOString().slice(0, 10)); // received yesterday -> earns from today (the plan's first day)
    expect(await accrue(sub.id, new Date())).toBe(1); // today's return shows today
    expect(await balanceOf('return_accrued', tokenId, member)).toBe(usdt('3.3'));
    expect(await checkIntegrity(admin)).toEqual(clean);
  });

  it('enrols new deposits as they arrive, and offline contributions as offline plans', async () => {
    await autoPlan();
    const member = await createUser();
    await fundMember(member, '500');
    expect(await enroll()).toBe(1);

    // An off-platform contribution recorded for a linked member yesterday.
    const holder = await one<{ id: string }>(admin, 'insert into public.offchain_holders (name, user_id, created_by, linked_by, linked_at) values ($1, $2, $3, $3, now()) returning id', ['Member', member, adminId]);
    await admin.query(
      "insert into public.offchain_entries (holder_id, kind, amount_micro, occurred_on, reason, idempotency_key, created_by) values ($1, 'contribution', 2000000000, $2, 'Cash handed to the team', 'test-contribution-1', $3)",
      [holder.id, yesterday(), adminId],
    );
    expect(await enroll()).toBe(1);
    const offline = await one<{ id: string; funding: string; principal_base: string }>(admin, "select id, funding, principal_base::text from public.plan_subscriptions where source_offchain_entry_id is not null");
    expect(offline).toMatchObject({ funding: 'offline', principal_base: usdt('2000').toString() });
    expect(await open(offline.id)).toBe('posted');
    expect(await balanceOf('plan_principal', tokenId, member)).toBe(0n); // offline principal stays off the ledger
    expect(await accrue(offline.id, new Date())).toBe(1);
    expect(await balanceOf('return_accrued', tokenId, member)).toBe(usdt('6.6'));
  });

  it('never enrols more than the member still has, and allows one automatic plan per token', async () => {
    await autoPlan();
    const member = await createUser();
    await fundMember(member, '100');
    await admin.query("update public.user_profiles set account_status = 'frozen' where user_id = $1", [member]);
    expect(await enroll()).toBe(0); // inactive accounts are not enrolled
    await admin.query("update public.user_profiles set account_status = 'active' where user_id = $1", [member]);

    const { id: second } = await withTransaction(web, (db) =>
      createPlan(db, { name: 'Auto 2', tokenId, dailyRatePpm: 3300, minPrincipal: '10', termDays: null, payableAfterDays: 0, principalLockDays: 0, termsReference: 'Terms v2', autoEnroll: true, staffUserId: adminId, actor: actor() }),
    );
    await expect(withTransaction(web, (db) => activatePlan(db, { planId: second, note: 'Second automatic plan', staffUserId: adminId, actor: actor() }))).rejects.toMatchObject({
      code: 'auto_plan_exists',
    });
    await expect(worker.query("insert into public.plan_subscriptions (user_id, plan_id, token_id, principal_base, client_key) values ($1, $2, $3, 1000000, 'worker-cannot-do-this-1')", [member, second, tokenId])).rejects.toThrow();
  });
});
