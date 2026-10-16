/**
 * Trading venue integration contract. A real implementation wraps an approved
 * exchange/broker API (read-only keys for executions and balances, held by the
 * worker only). The application never derives performance from anything but
 * imported executions and venue prices.
 */
import type { Execution } from '../investment/pnl';

export interface PriceQuote {
  symbol: string;
  price: bigint; // fixed 18
  source: string;
  asOf: Date;
}

export interface VenueAccountSnapshot {
  /** Venue-reported equity in the quote asset, fixed 18. Used for reconciliation. */
  equity: bigint;
  asOf: Date;
}

export interface TradingVenue {
  readonly name: string;
  readonly isSimulated: boolean;
  fetchExecutions(args: { poolId: number; since: Date | null; until: Date }): Promise<Execution[]>;
  fetchPrices(symbols: string[]): Promise<PriceQuote[]>;
  fetchAccountSnapshot(poolId: number): Promise<VenueAccountSnapshot>;
}

export class PriceFeedError extends Error {
  override name = 'PriceFeedError';
}
