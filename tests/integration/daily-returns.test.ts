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
    expect(await accrue(id, later(4))).toBe(3); // days +1, +2, +3 have ended
    expect(await accrue(id, later(4))).toBe(0);
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
    expect(await accrue(id, later(3))).toBe(2); // caught up
    expect(await accrue(id, later(30))).toBe(3); // term of 5 days, then nothing more
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
    await accrue(id, later(4));

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

  it('returns principal after the lock and stops accrual from the request day', async () => {
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
