import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { admin, balanceOf, closePools, createUser, resetAppData, simToken, usdt, worker } from '../helpers/db';
import { withTransaction, one } from '../../src/server/db-core';
import { ensureAccount, postEntry, transfer, checkIntegrity } from '../../src/server/ledger/ledger';
import { getPool, requestRedemption, requestSubscription } from '../../src/server/investment/orders';
import { importTrades, runValuation } from '../../src/server/investment/valuation';
import { unitsValue } from '../../src/server/investment/nav';
import { parseFixed } from '../../src/lib/money';
import type { Execution } from '../../src/server/investment/pnl';
import { PriceFeedError, type PriceQuote, type TradingVenue } from '../../src/server/trading/types';

/** Controllable venue double implementing the same interface as a real integration. */
class FakeVenue implements TradingVenue {
  readonly name = 'simulated-venue';
  readonly isSimulated = true;
  executions: Execution[] = [];
  prices = new Map<string, bigint>();
  clock = new Date();
  down = false;
  async fetchExecutions(args: { since: Date | null; until: Date }) {
    return this.executions.filter((e) => (!args.since || e.executedAt > args.since) && e.executedAt <= args.until);
  }
  async fetchPrices(symbols: string[]): Promise<PriceQuote[]> {
    if (this.down) throw new PriceFeedError('feed down');
    return symbols.map((s) => ({ symbol: s, price: this.prices.get(s) ?? 0n, source: 'fake', asOf: this.clock }));
  }
  async fetchAccountSnapshot() {
    return { equity: 0n, asOf: this.clock };
  }
}

const actor = { type: 'service' as const, id: 'test' };
let tokenId: number;
let poolId: number;
let venue: FakeVenue;
const H = 3600_000;
const T0 = Date.now() + H;
const at = (hours: number) => new Date(T0 + hours * H);

beforeEach(async () => {
  await resetAppData();
  tokenId = (await simToken()).id;
  poolId = Number((await one<{ id: number }>(admin, "select id from public.investment_pools where code = 'core-sim'")).id);
  venue = new FakeVenue();
});
afterAll(closePools);

async function fund(userId: string, amount: bigint) {
  const treasury = await ensureAccount(worker, 'treasury_hot', tokenId);
  const cash = await ensureAccount(worker, 'user_cash', tokenId, { userId });
  await postEntry(worker, { idempotencyKey: `test:fund:${userId}:${amount}`, eventType: 'test_fund', sourceType: 'test', sourceId: userId, description: 'test funding', postedBy: 'service:test', lines: transfer(treasury, cash, amount) });
  await withTransaction(worker, (db) => requestSubscription(db, { userId, poolId, tokenId, amount, idempotencyKey: `sub:${userId}:${amount}`, actor }));
}

async function value(hours: number) {
  venue.clock = at(hours);
  return withTransaction(worker, (db) => runValuation(db, venue, poolId, actor, at(hours)));
}

async function position(userId: string) {
  return one<{ units: string; cost_basis_base: string }>(admin, 'select units::text, cost_basis_base::text from public.investment_positions where user_id = $1', [userId]);
}

async function equity() {
  return balanceOf('pool_investor_equity', tokenId);
}

describe('trading P&L, NAV and allocation', () => {
  it('prices subscriptions forward, allocates gains and losses, and keeps the ledger equal to NAV', async () => {
    const a = await createUser();
    await fund(a, usdt('100'));

    // Strike 1: no assets yet. A subscribes at inception NAV (1.0).
    const v1 = await value(1);
    expect(v1.status).toBe('final');
    expect(BigInt(parseFixed((await position(a)).units))).toBe(100n * 10n ** 18n);
    expect(await balanceOf('pool_assets', tokenId)).toBe(usdt('100'));

    // The venue buys 0.04 SIMETH at 2500 with the pool's 100.
    venue.executions.push({ externalId: 'x1', symbol: 'SIMETH/TUSDT', side: 'buy', quantity: parseFixed('0.04'), price: parseFixed('2500'), fee: 0n, feeAsset: 'TUSDT', fundingCost: 0n, executedAt: at(1.5) });
    const imp1 = await withTransaction(worker, async (db) => importTrades(db, venue, await getPool(db, poolId), actor, at(2)));
    const imp2 = await withTransaction(worker, async (db) => importTrades(db, venue, await getPool(db, poolId), actor, at(2)));
    expect(imp1.inserted).toBe(1);
    expect(imp2.inserted).toBe(0); // duplicate import detected
    expect(imp2.duplicates).toBe(1);

    // B joins before strike 2; price rises 10%.
    const b = await createUser();
    await fund(b, usdt('100'));
    venue.prices.set('SIMETH/TUSDT', parseFixed('2750'));
    const v2 = await value(2);
    expect(v2.status).toBe('final');
    if (v2.status !== 'final') return;
    const navpu2 = v2.navpu;
    expect(navpu2).toBeGreaterThan(1_000000n * 10n ** 18n); // gain (net of fees)

    const allocA = await one<{ pnl_base: string }>(admin, 'select pnl_base::text from public.performance_allocations where user_id = $1 and valuation_id = $2', [a, v2.valuationId]);
    expect(BigInt(allocA.pnl_base)).toBeGreaterThan(usdt('8')); // ~+9 after fees
    // B received no allocation for the period before it joined, and its units are worth what it paid (rounded down).
    expect((await admin.query('select count(*)::int as n from public.performance_allocations where user_id = $1', [b])).rows[0].n).toBe(0);
    const bUnits = parseFixed((await position(b)).units);
    expect(unitsValue(bUnits, navpu2)).toBeLessThanOrEqual(usdt('100'));
    expect(unitsValue(bUnits, navpu2)).toBeGreaterThan(usdt('99.999998'));

    // Ledger pool equity equals units x NAV (up to rounding dust that stays in the pool).
    const aUnits = parseFixed((await position(a)).units);
    const nav = await equity();
    expect(nav - (unitsValue(aUnits, navpu2) + unitsValue(bUnits, navpu2))).toBeGreaterThanOrEqual(0n);
    expect(nav - (unitsValue(aUnits, navpu2) + unitsValue(bUnits, navpu2))).toBeLessThan(10n);

    // Strike 3: price falls; both holders take a loss, shown as negative allocations.
    venue.prices.set('SIMETH/TUSDT', parseFixed('2000'));
    const v3 = await value(3);
    expect(v3.status).toBe('final');
    if (v3.status !== 'final') return;
    expect(v3.navpu).toBeLessThan(navpu2);
    const losses = await admin.query('select user_id, pnl_base::text from public.performance_allocations where valuation_id = $1', [v3.valuationId]);
    expect(losses.rows).toHaveLength(2);
    for (const r of losses.rows) expect(BigInt(r.pnl_base)).toBeLessThan(0n);

    // A redeems everything at strike 4; the withdrawal is a cash flow, not an investment loss.
    await withTransaction(worker, (db) => requestRedemption(db, { userId: a, poolId, units: null, idempotencyKey: `red:${a}`, actor }));
    const navBefore = v3.navpu;
    const v4 = await value(4);
    if (v4.status !== 'final') throw new Error('expected final');
    // No price change: only one hour of management fee accrues.
    expect(v4.navpu).toBeLessThanOrEqual(navBefore);
    expect(navBefore - v4.navpu).toBeLessThan(navBefore / 10_000n);
    const cashA = await balanceOf('user_cash', tokenId, a);
    expect(cashA).toBe(unitsValue(aUnits, v4.navpu));
    expect(cashA).toBeLessThan(usdt('100')); // A ends with a real loss
    const red = await one<{ realized_pnl_base: string }>(admin, "select realized_pnl_base::text from public.investment_orders where kind = 'redemption'");
    expect(BigInt(red.realized_pnl_base)).toBe(cashA - usdt('100'));
    expect(parseFixed((await position(a)).units)).toBe(0n);

    expect(await checkIntegrity(admin)).toEqual({ unbalancedTokens: [], cacheMismatches: [] });
  });

  it('records a failed valuation and allocates nothing when the price feed is down', async () => {
    const a = await createUser();
    await fund(a, usdt('100'));
    await value(1);
    venue.executions.push({ externalId: 'x2', symbol: 'SIMETH/TUSDT', side: 'buy', quantity: parseFixed('0.01'), price: parseFixed('2500'), fee: 0n, feeAsset: 'TUSDT', fundingCost: 0n, executedAt: at(1.2) });
    await withTransaction(worker, async (db) => importTrades(db, venue, await getPool(db, poolId), actor, at(1.5)));
    venue.down = true;
    const v = await value(2);
    expect(v.status).toBe('failed');
    if (v.status === 'failed') expect(v.reason).toBe('price_feed_unavailable');
    expect((await admin.query('select count(*)::int as n from public.performance_allocations')).rows[0].n).toBe(0);
    expect((await admin.query("select count(*)::int as n from public.risk_events where kind = 'valuation_failed'")).rows[0].n).toBe(1);
  });

  it('finalizes each period at most once', async () => {
    await value(1);
    const again = await value(1);
    expect(again.status).toBe('exists');
  });

  it('pauses allocation when the allocations control is enabled', async () => {
    await admin.query("update public.system_controls set enabled = true where key = 'allocations_paused'");
    expect((await value(1)).status).toBe('paused');
  });
});
