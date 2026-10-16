/**
 * SIMULATED trading venue - development and demo only.
 *
 * Produces executions from a small rules-based strategy trading synthetic
 * instruments (SIMETH/TUSDT, SIMBTC/TUSDT) on a deterministic synthetic price
 * path. Results go both up and down. Everything it produces is flagged
 * is_simulated and the UI labels it SIMULATED; it is never presented as actual
 * investment performance.
 *
 * Prices are generated with floating-point trigonometry and then quantized to a
 * fixed 6-decimal string, exactly like data arriving from an external feed. All
 * accounting downstream is exact bigint arithmetic.
 */
import { many, type Db } from '../db-core';
import { FIXED_ONE, fixedToString, mulDivFloorSigned, parseFixed } from '@/lib/money';
import { applyExecutions, emptyPortfolio, type Execution } from '../investment/pnl';
import { PriceFeedError, type PriceQuote, type TradingVenue, type VenueAccountSnapshot } from './types';

const SLOT_MS = 4 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const FEE_RATE_BPS = 10n; // 0.10%

const INSTRUMENTS: Record<string, { base: number; amplitudes: [number, number, number]; drift: number }> = {
  'SIMETH/TUSDT': { base: 2500, amplitudes: [0.12, 0.05, 0.02], drift: 0 },
  'SIMBTC/TUSDT': { base: 60000, amplitudes: [0.08, 0.04, 0.015], drift: 0 },
};

export const SIM_SYMBOLS = Object.keys(INSTRUMENTS);

/** Deterministic synthetic price at time t (ms), quantized to 6 decimals, as fixed 18. */
export function simPrice(symbol: string, tMs: number): bigint {
  const inst = INSTRUMENTS[symbol];
  if (!inst) throw new PriceFeedError(`Unknown simulated instrument ${symbol}`);
  const d = tMs / DAY_MS;
  const [a1, a2, a3] = inst.amplitudes;
  const factor = 1 + a1 * Math.sin((2 * Math.PI * d) / 11) + a2 * Math.sin((2 * Math.PI * d) / 2.3 + 1) + a3 * Math.sin((2 * Math.PI * d) / 0.37 + 2);
  const quantized = (inst.base * factor).toFixed(6);
  return parseFixed(quantized);
}

interface SimExecRow {
  external_execution_id: string;
  order_ref: string;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: string;
  price: string;
  fee: string;
  fee_asset: string;
  executed_at: Date;
}

const toExecution = (r: SimExecRow): Execution => ({
  externalId: r.external_execution_id,
  symbol: r.symbol,
  side: r.side,
  quantity: parseFixed(r.quantity),
  price: parseFixed(r.price),
  fee: parseFixed(r.fee),
  feeAsset: r.fee_asset,
  fundingCost: 0n,
  executedAt: new Date(r.executed_at),
});

export class SimulatedVenue implements TradingVenue {
  readonly name = 'simulated-venue';
  readonly isSimulated = true;

  constructor(
    private readonly db: Db,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async fetchExecutions(args: { poolId: number; since: Date | null; until: Date }): Promise<Execution[]> {
    const rows = await many<SimExecRow>(
      this.db,
      `select external_execution_id, order_ref, symbol, side, quantity::text, price::text, fee::text, fee_asset, executed_at
         from public.sim_venue_executions
        where pool_id = $1 and ($2::timestamptz is null or executed_at > $2) and executed_at <= $3
        order by executed_at, id`,
      [args.poolId, args.since, args.until],
    );
    return rows.map(toExecution);
  }

  async fetchPrices(symbols: string[]): Promise<PriceQuote[]> {
    if (this.env.SIM_PRICE_FEED_DOWN === 'true') throw new PriceFeedError('Simulated price feed outage');
    const at = this.now();
    return symbols.map((symbol) => ({ symbol, price: simPrice(symbol, at.getTime()), source: 'simulated-price-path', asOf: at }));
  }

  /** Net capital at the venue from treasury transfers, as fixed 18 in quote units. */
  private async capitalFlows(poolId: number): Promise<bigint> {
    const rows = await many<{ kind: string; amount_base: string; decimals: number }>(
      this.db,
      `select tt.kind, tt.amount_base::text, t.decimals
         from public.treasury_transfers tt join public.supported_tokens t on t.id = tt.token_id
        where tt.pool_id = $1 and tt.status = 'completed' and tt.kind in ('to_venue', 'from_venue')`,
      [poolId],
    );
    let total = 0n;
    for (const r of rows) {
      const v = BigInt(r.amount_base) * 10n ** BigInt(18 - Number(r.decimals));
      total += r.kind === 'to_venue' ? v : -v;
    }
    return total;
  }

  private async state(poolId: number) {
    const all = await this.fetchExecutions({ poolId, since: null, until: new Date(8.64e15) });
    const portfolio = applyExecutions(all, 'TUSDT', emptyPortfolio());
    const cash = (await this.capitalFlows(poolId)) + portfolio.tradeCashFlow;
    return { portfolio, cash };
  }

  async fetchAccountSnapshot(poolId: number): Promise<VenueAccountSnapshot> {
    const at = this.now();
    const { portfolio, cash } = await this.state(poolId);
    let equity = cash;
    for (const p of portfolio.positions.values()) {
      if (p.quantity > 0n) equity += mulDivFloorSigned(p.quantity, simPrice(p.symbol, at.getTime()), FIXED_ONE);
    }
    return { equity, asOf: at };
  }

  /**
   * Run the simulated strategy for the current 4-hour slot (at most once per
   * slot). Target exposure per instrument follows 24h momentum, capped at 30%
   * of equity each; trades below 1% of equity are skipped.
   */
  async runStrategy(poolId: number): Promise<number> {
    const at = this.now();
    const slot = Math.floor(at.getTime() / SLOT_MS);
    const { portfolio, cash } = await this.state(poolId);
    let equity = cash;
    const prices = new Map(SIM_SYMBOLS.map((s) => [s, simPrice(s, at.getTime())]));
    for (const p of portfolio.positions.values()) equity += mulDivFloorSigned(p.quantity, prices.get(p.symbol) ?? 0n, FIXED_ONE);
    if (equity <= 0n) return 0;

    let available = cash;
    let inserted = 0;
    for (const symbol of SIM_SYMBOLS) {
      const ref = `sim-slot-${slot}-${symbol}`;
      const price = prices.get(symbol)!;
      const prev = simPrice(symbol, at.getTime() - DAY_MS);
      // momentum in basis points, mapped to a 0-30% target weight
      const momentumBps = ((price - prev) * 10_000n) / prev;
      let weightBps = 1_500n + momentumBps * 3n;
      if (weightBps < 0n) weightBps = 0n;
      if (weightBps > 3_000n) weightBps = 3_000n;

      const targetValue = (equity * weightBps) / 10_000n;
      const held = portfolio.positions.get(symbol)?.quantity ?? 0n;
      const heldValue = mulDivFloorSigned(held, price, FIXED_ONE);
      let deltaValue = targetValue - heldValue;
      if (deltaValue > 0n && deltaValue > available) deltaValue = available > 0n ? available : 0n;
      if ((deltaValue < 0n ? -deltaValue : deltaValue) * 100n < equity) continue; // < 1% of equity

      const side = deltaValue > 0n ? 'buy' : 'sell';
      let qty = ((deltaValue < 0n ? -deltaValue : deltaValue) * FIXED_ONE) / price;
      qty = (qty / 10n ** 10n) * 10n ** 10n; // venue lot size: 1e-8
      if (side === 'sell' && qty > held) qty = held;
      if (qty <= 0n) continue;
      const notional = mulDivFloorSigned(qty, price, FIXED_ONE);
      const fee = (notional * FEE_RATE_BPS) / 10_000n;
      if (side === 'buy') available -= notional + fee;

      const res = await this.db.query(
        `insert into public.sim_venue_executions (pool_id, external_execution_id, order_ref, symbol, side, quantity, price, fee, fee_asset, executed_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'TUSDT', $9) on conflict (external_execution_id) do nothing`,
        [poolId, `${ref}-fill-1`, ref, symbol, side, fixedToString(qty), fixedToString(price), fixedToString(fee), at],
      );
      inserted += res.rowCount ?? 0;
    }
    return inserted;
  }
}

export function getTradingVenue(db: Db, venueName: string, env: NodeJS.ProcessEnv = process.env): TradingVenue {
  if (venueName === 'simulated-venue') return new SimulatedVenue(db, env);
  // No real venue is integrated. Refuse instead of substituting simulated data.
  throw new Error(`Trading venue "${venueName}" is not integrated in this build`);
}
