/**
 * Deterministic NAV scenarios with hand-computed expected values.
 *
 * Every scenario: user A subscribes 100 tUSDT at inception (NAV/unit 1.0), the
 * pool buys 0.04 SIMETH at 2500 (all 100), and the next hourly strike marks the
 * position. Fee policy v1: 2%/yr management on GAV (pro rata per second) and 10%
 * performance above the high-water mark, all rounded down in base units.
 *   management fee for 1h = floor(GAV * 200 * 3600 / (10_000 * 31_536_000))
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { admin, balanceOf, closePools, createUser, resetAppData, simToken, usdt, worker } from '../helpers/db';
import { withTransaction, one } from '../../src/server/db-core';
import { ensureAccount, postEntry, transfer, checkIntegrity } from '../../src/server/ledger/ledger';
import { getPool, requestSubscription } from '../../src/server/investment/orders';
import { importTrades, runValuation } from '../../src/server/investment/valuation';
import { parseFixed } from '../../src/lib/money';
import { applyExecutions, fixedToBase, markToMarket, type Execution } from '../../src/server/investment/pnl';
import { PriceFeedError, type PriceQuote, type TradingVenue } from '../../src/server/trading/types';

class FakeVenue implements TradingVenue {
  readonly name = 'simulated-venue';
  readonly isSimulated = true;
  executions: Execution[] = [];
  prices = new Map<string, bigint>();
  clock = new Date();
  priceAge = 0;
  async fetchExecutions(args: { since: Date | null; until: Date }) {
    return this.executions.filter((e) => (!args.since || e.executedAt > args.since) && e.executedAt <= args.until);
  }
  async fetchPrices(symbols: string[]): Promise<PriceQuote[]> {
    if (!this.prices.size) throw new PriceFeedError('feed down');
    return symbols.map((s) => ({ symbol: s, price: this.prices.get(s) ?? 0n, source: 'fake', asOf: new Date(this.clock.getTime() - this.priceAge) }));
  }
  async fetchAccountSnapshot() {
    return { equity: 0n, asOf: this.clock };
  }
}

const actor = { type: 'service' as const, id: 'test' };
const SYMBOL = 'SIMETH/TUSDT';
const H = 3600_000;
const T0 = Math.floor(Date.now() / H) * H + 2 * H; // on an hour boundary, in the future
const at = (hours: number) => new Date(T0 + hours * H);
let tokenId: number;
let poolId: number;
let venue: FakeVenue;

beforeEach(async () => {
  await resetAppData();
  tokenId = (await simToken()).id;
  poolId = Number((await one<{ id: number }>(admin, "select id from public.investment_pools where code = 'core-sim'")).id);
  venue = new FakeVenue();
});
afterAll(closePools);

async function fundAndSubscribe(userId: string, amount: bigint) {
  const treasury = await ensureAccount(worker, 'treasury_hot', tokenId);
  const cash = await ensureAccount(worker, 'user_cash', tokenId, { userId });
  await postEntry(worker, { idempotencyKey: `test:fund:${userId}:${amount}`, eventType: 'test_fund', sourceType: 'test', sourceId: userId, description: 'test funding', postedBy: 'service:test', lines: transfer(treasury, cash, amount) });
  await withTransaction(worker, (db) => requestSubscription(db, { userId, poolId, tokenId, amount, idempotencyKey: `sub:${userId}:${amount}`, actor }));
}

async function value(hours: number) {
  venue.clock = at(hours);
  return withTransaction(worker, (db) => runValuation(db, venue, poolId, actor, at(hours)));
}

async function importUntil(hours: number) {
  return withTransaction(worker, async (db) => importTrades(db, venue, await getPool(db, poolId), actor, at(hours)));
}

interface ValRow {
  status: string;
  nav_base: string;
  navpu: string;
  gross_asset_value_base: string;
  cash_base: string;
  positions_value_base: string;
  fees_accrued_period_base: string;
  realized_pnl_cum_base: string;
  unrealized_pnl_base: string;
  realized_pnl_period_base: string;
  unrealized_change_period_base: string;
  prices: Record<string, string>;
  valued_at: Date;
}
const valuation = (id: string) =>
  one<ValRow>(
    admin,
    `select status, nav_base::text, navpu::text, gross_asset_value_base::text, cash_base::text, positions_value_base::text, fees_accrued_period_base::text,
            realized_pnl_cum_base::text, unrealized_pnl_base::text, realized_pnl_period_base::text, unrealized_change_period_base::text, prices, valued_at
       from public.portfolio_valuations where id = $1`,
    [id],
  );
const allocation = async (userId: string, valuationId: string) =>
  (await admin.query('select pnl_base::text from public.performance_allocations where user_id = $1 and valuation_id = $2', [userId, valuationId])).rows[0]?.pnl_base as string | undefined;

/** A at inception, then the pool buys 0.04 SIMETH @ 2500 (fee in quote) and the price moves to `mark`. */
async function scenario(mark: string, opts: { fee?: string; qty?: string } = {}) {
  const a = await createUser();
  await fundAndSubscribe(a, usdt('100'));
  const v1 = await value(1);
  expect(v1.status).toBe('final');
  venue.executions.push({ externalId: 'buy-1', symbol: SYMBOL, side: 'buy', quantity: parseFixed(opts.qty ?? '0.04'), price: parseFixed('2500'), fee: parseFixed(opts.fee ?? '0'), feeAsset: 'TUSDT', fundingCost: 0n, executedAt: at(1.5) });
  await importUntil(1.9);
  venue.prices.set(SYMBOL, parseFixed(mark));
  const v2 = await value(2);
  if (v2.status !== 'final') throw new Error(`expected final valuation, got ${v2.status}`);
  return { a, v2, row: await valuation(v2.valuationId) };
}

describe('deterministic NAV scenarios', () => {
  it('profitable portfolio: +10% mark, management and performance fees, gain allocated', async () => {
    const { a, v2, row } = await scenario('2750');
    // GAV 110.000000; mgmt floor(110e6*200*3600/315.36e12) = 251; pre-fee NAV 109.999749
    // performance: 10% of (1.09999749 - 1.0) * 100 units = 999974 (floored)
    expect(row.gross_asset_value_base).toBe('110000000');
    expect(row.cash_base).toBe('0');
    expect(row.fees_accrued_period_base).toBe(String(251 + 999_974));
    expect(row.nav_base).toBe('108999775');
    expect(row.realized_pnl_cum_base).toBe('0');
    expect(row.unrealized_pnl_base).toBe('10000000');
    expect(row.unrealized_change_period_base).toBe('10000000');
    expect(await allocation(a, v2.valuationId)).toBe(String(108_999_775 - 100_000_000));
    expect(await balanceOf('pool_investor_equity', tokenId)).toBe(108_999_775n);
    expect(await balanceOf('pool_fees_payable', tokenId)).toBe(1_000_225n);
    // High-water mark moves up to the new NAV per unit.
    const pool = await one<{ hwm: string }>(admin, 'select high_water_mark::text as hwm from public.investment_pools where id = $1', [poolId]);
    expect(pool.hwm).toBe(row.navpu);
  });

  it('losing portfolio: -20% mark, no performance fee, negative allocation', async () => {
    const { a, v2, row } = await scenario('2000');
    // GAV 80; mgmt floor(80e6*200*3600/315.36e12) = 182
    expect(row.gross_asset_value_base).toBe('80000000');
    expect(row.fees_accrued_period_base).toBe('182');
    expect(row.nav_base).toBe('79999818');
    expect(row.unrealized_pnl_base).toBe('-20000000');
    expect(await allocation(a, v2.valuationId)).toBe('-20000182');
    expect(BigInt(parseFixed(row.navpu))).toBeLessThan(10n ** 24n); // below 1.0 per unit
    const pool = await one<{ hwm: string }>(admin, 'select high_water_mark::text as hwm from public.investment_pools where id = $1', [poolId]);
    expect(parseFixed(pool.hwm)).toBe(10n ** 24n); // unchanged
  });

  it('unchanged portfolio: only the management fee accrues', async () => {
    const { a, v2, row } = await scenario('2500');
    // GAV 100; mgmt floor(100e6*200*3600/315.36e12) = 228
    expect(row.nav_base).toBe('99999772');
    expect(row.unrealized_pnl_base).toBe('0');
    expect(row.realized_pnl_period_base).toBe('0');
    expect(await allocation(a, v2.valuationId)).toBe('-228');
  });

  it('accounts for trading fees and separates realized from unrealized P&L', async () => {
    // Buy 0.0396 @ 2500 = 99 + 1 fee; price unchanged -> unrealized -1 (the fee is in the cost basis).
    const { row } = await scenario('2500', { qty: '0.0396', fee: '1' });
    expect(row.cash_base).toBe('0');
    expect(row.positions_value_base).toBe('99000000');
    expect(row.unrealized_pnl_base).toBe('-1000000');
    // Sell half at 3000 (fee 0.5): realized = 59.4 - 0.5 - 50 = 8.9; the rest stays unrealized.
    venue.executions.push({ externalId: 'sell-1', symbol: SYMBOL, side: 'sell', quantity: parseFixed('0.0198'), price: parseFixed('3000'), fee: parseFixed('0.5'), feeAsset: 'TUSDT', fundingCost: 0n, executedAt: at(2.5) });
    await importUntil(2.9);
    venue.prices.set(SYMBOL, parseFixed('3000'));
    const v3 = await value(3);
    if (v3.status !== 'final') throw new Error('expected final');
    const r3 = await valuation(v3.valuationId);
    expect(r3.realized_pnl_cum_base).toBe('8900000');
    expect(r3.realized_pnl_period_base).toBe('8900000');
    expect(r3.unrealized_pnl_base).toBe('9400000'); // 0.0198*3000 - 50
    expect(r3.cash_base).toBe('58900000');
  });

  it('a new subscriber receives no gain earned before it joined, and its money is not counted as profit', async () => {
    const { v2 } = await scenario('2750');
    const navpu2 = parseFixed((await valuation(v2.valuationId)).navpu);
    const b = await createUser();
    await fundAndSubscribe(b, usdt('200')); // executes at the next strike, at that strike's NAV/unit
    venue.prices.set(SYMBOL, parseFixed('2750'));
    const v3 = await value(3);
    if (v3.status !== 'final') throw new Error('expected final');
    const r3 = await valuation(v3.valuationId);
    // B was not a holder during period 3, so it has no allocation for it.
    expect(await allocation(b, v3.valuationId)).toBeUndefined();
    // B's 200 is capital, not performance: NAV/unit only moved by one hour of management fee.
    const navpu3 = parseFixed(r3.navpu);
    expect(navpu3).toBeLessThanOrEqual(navpu2);
    expect(navpu2 - navpu3).toBeLessThan(navpu2 / 100_000n);
    expect(r3.unrealized_change_period_base).toBe('0');
    const bUnits = parseFixed((await one<{ units: string }>(admin, 'select units::text from public.investment_positions where user_id = $1', [b])).units);
    expect(bUnits).toBe((200_000000n * 10n ** 36n) / navpu3); // issued at the strike's NAV/unit, rounded down
  });

  it('withdrawing cash from the pool is a redemption, not a loss for the remaining holders', async () => {
    const { a } = await scenario('2500');
    const b = await createUser();
    await fundAndSubscribe(b, usdt('100'));
    await value(3); // B joins at NAV/unit ~0.99999772
    const { requestRedemption } = await import('../../src/server/investment/orders');
    await withTransaction(worker, (db) => requestRedemption(db, { userId: a, poolId, units: null, idempotencyKey: `red:${a}`, actor }));
    const v4 = await value(4);
    if (v4.status !== 'final') throw new Error('expected final');
    const bAlloc = BigInt((await allocation(b, v4.valuationId))!);
    // B's result for the period is only its share of one hour of fees; A's exit does not hit B.
    expect(bAlloc).toBeLessThanOrEqual(0n);
    expect(bAlloc).toBeGreaterThan(-1_000n);
    expect(await checkIntegrity(admin)).toEqual({ unbalancedTokens: [], cacheMismatches: [] });
  });

  it('stores a reproducible snapshot: positions recomputed from executions and stored prices match', async () => {
    const { v2, row } = await scenario('2750', { qty: '0.0396', fee: '1' });
    const execs = await admin.query(
      'select external_execution_id, symbol, side, quantity::text, price::text, fee::text, fee_asset, funding_cost::text, executed_at from public.trade_executions where pool_id = $1 and executed_at <= $2',
      [poolId, row.valued_at],
    );
    const state = applyExecutions(
      execs.rows.map((r) => ({ externalId: r.external_execution_id, symbol: r.symbol, side: r.side, quantity: parseFixed(r.quantity), price: parseFixed(r.price), fee: parseFixed(r.fee), feeAsset: r.fee_asset, fundingCost: parseFixed(r.funding_cost), executedAt: new Date(r.executed_at) })),
      'TUSDT',
    );
    const prices = new Map(Object.entries(row.prices).map(([k, v]) => [k, parseFixed(v)]));
    expect(fixedToBase(markToMarket(state, prices).marketValue, 6).toString()).toBe(row.positions_value_base);
    // The ledger equity posted for the strike equals the stored NAV.
    expect((await balanceOf('pool_investor_equity', tokenId)).toString()).toBe(row.nav_base);
    // A fill executed after the strike time (imported late) does not change that strike.
    venue.executions.push({ externalId: 'late', symbol: SYMBOL, side: 'sell', quantity: parseFixed('0.01'), price: parseFixed('2750'), fee: 0n, feeAsset: 'TUSDT', fundingCost: 0n, executedAt: at(2.2) });
    await importUntil(2.3);
    expect((await valuation(v2.valuationId)).positions_value_base).toBe(row.positions_value_base);
  });

  it('holds the valuation when prices are stale, missing or future-dated', async () => {
    const a = await createUser();
    await fundAndSubscribe(a, usdt('100'));
    await value(1);
    venue.executions.push({ externalId: 'buy-1', symbol: SYMBOL, side: 'buy', quantity: parseFixed('0.04'), price: parseFixed('2500'), fee: 0n, feeAsset: 'TUSDT', fundingCost: 0n, executedAt: at(1.5) });
    await importUntil(1.9);
    venue.prices.set(SYMBOL, parseFixed('2600'));

    venue.priceAge = 20 * 60_000; // 20 minutes old
    const stale = await value(2);
    expect(stale).toMatchObject({ status: 'failed', reason: 'price_feed_unavailable' });

    venue.priceAge = -5 * 60_000; // 5 minutes in the future
    expect(await value(2)).toMatchObject({ status: 'failed', reason: 'price_feed_unavailable' });

    venue.priceAge = 0;
    venue.prices = new Map([['OTHER/TUSDT', parseFixed('1')]]); // no price for the open position
    expect(await value(2)).toMatchObject({ status: 'failed', reason: 'price_feed_unavailable' });

    expect((await admin.query('select count(*)::int as n from public.performance_allocations')).rows[0].n).toBe(0); // nothing allocated while held
    expect((await admin.query("select count(*)::int as n from public.risk_events where kind = 'valuation_failed'")).rows[0].n).toBe(3);
    // Once a fresh price is available the period can still be finalized.
    venue.prices = new Map([[SYMBOL, parseFixed('2600')]]);
    expect((await value(2)).status).toBe('final');
  });
});
