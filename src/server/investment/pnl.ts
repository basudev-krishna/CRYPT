/**
 * Position and P&L engine (pure functions, no I/O).
 *
 * Method: weighted-average cost, long-only, quote currency = the pool's token.
 * All quantities and prices are 18-decimal fixed point (bigint).
 *
 *   buy:   qty += q; cost += q*p + fee
 *   sell:  realized += q*p - fee - avgCost*q; cost -= avgCost*q; qty -= q
 *   cash:  -(q*p) - fee for buys, +(q*p) - fee for sells, -funding for both
 *   unrealized = qty*mark - cost
 *
 * Fees in the base asset change the quantity instead of cash (a buy receives
 * q - fee; a sell disposes of q + fee). They are reported in `fees` at their
 * quote value at the execution price.
 */
import { FIXED_ONE, mulDivFloorSigned } from '@/lib/money';

export interface Execution {
  externalId: string;
  symbol: string; // BASE/QUOTE
  side: 'buy' | 'sell';
  quantity: bigint; // fixed 18
  price: bigint; // fixed 18
  fee: bigint; // fixed 18
  feeAsset: string;
  fundingCost: bigint; // fixed 18, quote; positive = cost
  executedAt: Date;
}

export interface PositionState {
  symbol: string;
  quantity: bigint;
  costBasis: bigint; // total quote cost of the open quantity
  realizedPnl: bigint;
  fees: bigint;
}

export interface PortfolioState {
  positions: Map<string, PositionState>;
  tradeCashFlow: bigint; // net quote cash from trading
  realizedPnl: bigint;
  fees: bigint;
  funding: bigint;
}

export class TradeValidationError extends Error {
  override name = 'TradeValidationError';
  constructor(
    message: string,
    readonly externalId: string,
  ) {
    super(message);
  }
}

const mul = (a: bigint, b: bigint) => mulDivFloorSigned(a, b, FIXED_ONE);

export function splitSymbol(symbol: string): { base: string; quote: string } {
  const [base, quote] = symbol.split('/');
  if (!base || !quote) throw new Error(`Invalid symbol ${symbol}`);
  return { base, quote };
}

export function validateExecution(e: Execution, quoteAsset: string): void {
  const { base, quote } = splitSymbol(e.symbol);
  if (quote !== quoteAsset) throw new TradeValidationError(`Quote ${quote} does not match pool currency ${quoteAsset}`, e.externalId);
  if (e.quantity <= 0n || e.price <= 0n) throw new TradeValidationError('Quantity and price must be positive', e.externalId);
  if (e.fee < 0n) throw new TradeValidationError('Fee cannot be negative', e.externalId);
  if (e.feeAsset !== base && e.feeAsset !== quote) throw new TradeValidationError(`Unsupported fee asset ${e.feeAsset}`, e.externalId);
}

export function emptyPortfolio(): PortfolioState {
  return { positions: new Map(), tradeCashFlow: 0n, realizedPnl: 0n, fees: 0n, funding: 0n };
}

/** Apply executions in chronological order. Throws on invalid or short-selling executions. */
export function applyExecutions(executions: Execution[], quoteAsset: string, state: PortfolioState = emptyPortfolio()): PortfolioState {
  const sorted = [...executions].sort((a, b) => a.executedAt.getTime() - b.executedAt.getTime() || a.externalId.localeCompare(b.externalId));
  for (const e of sorted) {
    validateExecution(e, quoteAsset);
    const { base } = splitSymbol(e.symbol);
    const notional = mul(e.quantity, e.price);
    const feeInBase = e.feeAsset === base;
    const feeQuote = feeInBase ? mul(e.fee, e.price) : e.fee;
    // Quote-asset fees are paid in cash. Base-asset fees are paid in the traded
    // asset: a buy receives quantity - fee, a sell gives up quantity + fee.
    const feeCash = feeInBase ? 0n : e.fee;
    const baseDelta = e.side === 'buy' ? e.quantity - (feeInBase ? e.fee : 0n) : e.quantity + (feeInBase ? e.fee : 0n);
    const pos = state.positions.get(e.symbol) ?? { symbol: e.symbol, quantity: 0n, costBasis: 0n, realizedPnl: 0n, fees: 0n };

    if (e.side === 'buy') {
      if (baseDelta <= 0n) throw new TradeValidationError('Base-asset fee must be smaller than the bought quantity', e.externalId);
      pos.quantity += baseDelta;
      pos.costBasis += notional + feeCash; // the whole cash outlay is the cost of what was received
      state.tradeCashFlow -= notional + feeCash;
    } else {
      if (baseDelta > pos.quantity) {
        throw new TradeValidationError(`Sell of ${baseDelta} (incl. fee) exceeds open quantity ${pos.quantity} (short selling unsupported)`, e.externalId);
      }
      // Cost released proportionally; the final sell releases all remaining cost to avoid dust.
      const released = baseDelta === pos.quantity ? pos.costBasis : mulDivFloorSigned(pos.costBasis, baseDelta, pos.quantity);
      const realized = notional - feeCash - released;
      pos.quantity -= baseDelta;
      pos.costBasis -= released;
      pos.realizedPnl += realized;
      state.realizedPnl += realized;
      state.tradeCashFlow += notional - feeCash;
    }
    pos.fees += feeQuote;
    state.fees += feeQuote;
    if (e.fundingCost !== 0n) {
      state.funding += e.fundingCost;
      state.realizedPnl -= e.fundingCost;
      pos.realizedPnl -= e.fundingCost;
      state.tradeCashFlow -= e.fundingCost;
    }
    state.positions.set(e.symbol, pos);
  }
  return state;
}

export interface MarkedPosition {
  symbol: string;
  quantity: bigint;
  costBasis: bigint;
  mark: bigint;
  marketValue: bigint;
  unrealizedPnl: bigint;
  realizedPnl: bigint;
}

export class MissingPriceError extends Error {
  override name = 'MissingPriceError';
}

/** Mark open positions to market. Every open position must have a price. */
export function markToMarket(state: PortfolioState, prices: Map<string, bigint>): { positions: MarkedPosition[]; marketValue: bigint; unrealizedPnl: bigint } {
  const positions: MarkedPosition[] = [];
  let marketValue = 0n;
  let unrealized = 0n;
  for (const p of state.positions.values()) {
    if (p.quantity === 0n) {
      positions.push({ symbol: p.symbol, quantity: 0n, costBasis: 0n, mark: prices.get(p.symbol) ?? 0n, marketValue: 0n, unrealizedPnl: 0n, realizedPnl: p.realizedPnl });
      continue;
    }
    const mark = prices.get(p.symbol);
    if (mark === undefined || mark <= 0n) throw new MissingPriceError(`No valid price for open position ${p.symbol}`);
    const mv = mul(p.quantity, mark);
    const u = mv - p.costBasis;
    marketValue += mv;
    unrealized += u;
    positions.push({ symbol: p.symbol, quantity: p.quantity, costBasis: p.costBasis, mark, marketValue: mv, unrealizedPnl: u, realizedPnl: p.realizedPnl });
  }
  return { positions, marketValue, unrealizedPnl: unrealized };
}

/** Convert an 18-decimal fixed-point quote amount to token base units, rounding toward negative infinity. */
export function fixedToBase(value: bigint, tokenDecimals: number): bigint {
  const divisor = 10n ** BigInt(18 - tokenDecimals);
  return mulDivFloorSigned(value, 1n, divisor);
}

export function baseToFixed(value: bigint, tokenDecimals: number): bigint {
  return value * 10n ** BigInt(18 - tokenDecimals);
}
