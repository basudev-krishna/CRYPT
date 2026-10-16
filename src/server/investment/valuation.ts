/**
 * Trade import, portfolio valuation, performance allocation and NAV strike.
 *
 * runValuation() is the single place where investment results reach customer
 * accounts. Within one database transaction it:
 *   1. values the pool from imported executions and venue prices,
 *   2. strikes NAV (management + high-water-mark performance fees, policy-versioned),
 *   3. posts mark-to-market and fee entries so ledger pool equity == NAV,
 *   4. records each holder's share of the period result (performance_allocations),
 *   5. executes pending subscriptions/redemptions at the new NAV per unit.
 * A period can be finalized at most once (unique index on pool + period_key).
 * If executions are invalid or prices are unavailable, a failed valuation is
 * recorded and nothing is allocated ("performance unavailable").
 */
import { many, maybeOne, one, type Db } from '../db-core';
import { fixedToString, parseBase, parseFixed } from '@/lib/money';
import { cachedBalance, ensureAccount, postEntry, type LedgerLine } from '../ledger/ledger';
import { currentPolicy, isControlEnabled, notify, raiseRiskEvent, recordAudit, type Actor } from '../ops';
import { getToken } from '../chains/registry';
import { applyExecutions, baseToFixed, fixedToBase, markToMarket, MissingPriceError, TradeValidationError, validateExecution, type Execution } from './pnl';
import { allocatePeriod, costBasisReleased, strikeNav, unitsForAmount, unitsValue } from './nav';
import { getPool, type PoolInfo } from './orders';
import { PriceFeedError, type TradingVenue } from '../trading/types';

const MAX_PRICE_AGE_MS = 15 * 60 * 1000;
const MAX_PRICE_CLOCK_SKEW_MS = 60 * 1000;

// -----------------------------------------------------------------------------
// Trade import
// -----------------------------------------------------------------------------
export interface ImportResult {
  batchId: string;
  received: number;
  inserted: number;
  duplicates: number;
  rejected: number;
}

export async function importTrades(db: Db, venue: TradingVenue, pool: PoolInfo, actor: Actor, until = new Date()): Promise<ImportResult> {
  if (venue.name !== pool.venue) throw new Error(`Venue ${venue.name} does not serve pool ${pool.code}`);
  const token = await getToken(db, pool.tokenId);
  const last = await maybeOne<{ t: Date | null }>(db, 'select max(executed_at) as t from public.trade_executions where pool_id = $1', [pool.id]);
  // Overlap the window by an hour: late-arriving fills are caught, duplicates are ignored.
  const since = last?.t ? new Date(new Date(last.t).getTime() - 3600_000) : null;
  const executions = await venue.fetchExecutions({ poolId: pool.id, since, until });

  const batch = await one<{ id: string }>(
    db,
    `insert into public.trade_import_batches (pool_id, venue, requested_by, window_start, window_end, received)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [pool.id, venue.name, `${actor.type}:${actor.id}`, since, until, executions.length],
  );
  let inserted = 0;
  let duplicates = 0;
  const errors: { externalId: string; error: string }[] = [];
  for (const e of executions) {
    try {
      validateExecution(e, token.symbol.toUpperCase());
    } catch (err) {
      errors.push({ externalId: e.externalId, error: (err as Error).message });
      continue;
    }
    const res = await db.query(
      `insert into public.trade_executions
         (pool_id, venue, external_execution_id, order_ref, symbol, side, quantity, price, fee, fee_asset, funding_cost, executed_at, import_batch_id, is_simulated)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       on conflict (venue, external_execution_id) do nothing`,
      [
        pool.id,
        venue.name,
        e.externalId,
        null,
        e.symbol,
        e.side,
        fixedToString(e.quantity),
        fixedToString(e.price),
        fixedToString(e.fee),
        e.feeAsset,
        fixedToString(e.fundingCost),
        e.executedAt,
        batch.id,
        venue.isSimulated,
      ],
    );
    if (res.rowCount === 1) inserted++;
    else duplicates++;
  }
  await db.query('update public.trade_import_batches set inserted = $2, duplicates = $3, rejected = $4, errors = $5::jsonb where id = $1', [
    batch.id,
    inserted,
    duplicates,
    errors.length,
    JSON.stringify(errors),
  ]);
  if (errors.length) {
    await raiseRiskEvent(db, { kind: 'trade_import_rejections', severity: 'medium', subjectType: 'trade_import_batch', subjectId: batch.id, details: { errors } });
  }
  return { batchId: batch.id, received: executions.length, inserted, duplicates, rejected: errors.length };
}

/** Executions up to and including `asOf`, so a strike only reflects fills that existed at its time (reproducible). */
async function loadExecutions(db: Db, poolId: number, asOf: Date): Promise<Execution[]> {
  const rows = await many<{
    external_execution_id: string;
    symbol: string;
    side: 'buy' | 'sell';
    quantity: string;
    price: string;
    fee: string;
    fee_asset: string;
    funding_cost: string;
    executed_at: Date;
  }>(
    db,
    `select external_execution_id, symbol, side, quantity::text, price::text, fee::text, fee_asset, funding_cost::text, executed_at
       from public.trade_executions where pool_id = $1 and executed_at <= $2 order by executed_at, id`,
    [poolId, asOf],
  );
  return rows.map((r) => ({
    externalId: r.external_execution_id,
    symbol: r.symbol,
    side: r.side,
    quantity: parseFixed(r.quantity),
    price: parseFixed(r.price),
    fee: parseFixed(r.fee),
    feeAsset: r.fee_asset,
    fundingCost: parseFixed(r.funding_cost),
    executedAt: new Date(r.executed_at),
  }));
}

// -----------------------------------------------------------------------------
// Valuation
// -----------------------------------------------------------------------------
export function periodKeyFor(at: Date, frequency: 'daily' | 'hourly'): string {
  const iso = at.toISOString();
  return frequency === 'daily' ? iso.slice(0, 10) : iso.slice(0, 13);
}

export type ValuationOutcome =
  | { status: 'final'; valuationId: string; navpu: bigint; executedOrders: number }
  | { status: 'exists'; valuationId: string }
  | { status: 'paused' }
  | { status: 'failed'; valuationId: string; reason: string };

async function recordFailed(db: Db, pool: PoolInfo, periodKey: string, at: Date, reason: string, details: Record<string, unknown>): Promise<ValuationOutcome> {
  const row = await one<{ id: string }>(
    db,
    `insert into public.portfolio_valuations (pool_id, valuation_date, period_key, valued_at, status, failure_reason, is_simulated, prices)
     values ($1, $2::date, $3, $4, 'failed', $5, $6, $7::jsonb) returning id`,
    [pool.id, at.toISOString().slice(0, 10), periodKey, at, reason, pool.isSimulated, JSON.stringify(details)],
  );
  await raiseRiskEvent(db, { kind: 'valuation_failed', severity: 'high', subjectType: 'portfolio_valuation', subjectId: row.id, details: { reason, ...details } });
  await notify(db, { audience: 'operations', kind: 'valuation_failed', payload: { poolId: pool.id, reason } });
  return { status: 'failed', valuationId: row.id, reason };
}

export class ValuationIntegrityError extends Error {
  override name = 'ValuationIntegrityError';
}

export async function runValuation(db: Db, venue: TradingVenue, poolId: number, actor: Actor, now = new Date()): Promise<ValuationOutcome> {
  const pool = await getPool(db, poolId, true); // row lock serializes concurrent runs
  if (venue.name !== pool.venue) throw new Error(`Venue ${venue.name} does not serve pool ${pool.code}`);
  const allocationPolicy = await currentPolicy(db, 'allocation');
  const periodKey = periodKeyFor(now, allocationPolicy.params.valuation_frequency);

  const existing = await maybeOne<{ id: string }>(
    db,
    "select id from public.portfolio_valuations where pool_id = $1 and period_key = $2 and status = 'final'",
    [pool.id, periodKey],
  );
  if (existing) return { status: 'exists', valuationId: existing.id };
  if (await isControlEnabled(db, 'allocations_paused')) return { status: 'paused' };

  const token = await getToken(db, pool.tokenId);
  const decimals = token.decimals;

  // 1. Positions from executions.
  let state;
  try {
    state = applyExecutions(await loadExecutions(db, pool.id, now), token.symbol.toUpperCase());
  } catch (err) {
    if (err instanceof TradeValidationError) return recordFailed(db, pool, periodKey, now, 'invalid_executions', { error: err.message, externalId: err.externalId });
    throw err;
  }

  // 2. Prices for open positions.
  const openSymbols = [...state.positions.values()].filter((p) => p.quantity > 0n).map((p) => p.symbol);
  const prices = new Map<string, bigint>();
  let priceSource: string | null = null;
  if (openSymbols.length) {
    try {
      const quotes = await venue.fetchPrices(openSymbols);
      for (const q of quotes) {
        if (now.getTime() - q.asOf.getTime() > MAX_PRICE_AGE_MS) throw new PriceFeedError(`Stale price for ${q.symbol} (${q.asOf.toISOString()})`);
        if (q.asOf.getTime() - now.getTime() > MAX_PRICE_CLOCK_SKEW_MS) throw new PriceFeedError(`Price for ${q.symbol} is dated in the future (${q.asOf.toISOString()})`);
        prices.set(q.symbol, q.price);
        priceSource = q.source;
      }
    } catch (err) {
      if (err instanceof PriceFeedError) return recordFailed(db, pool, periodKey, now, 'price_feed_unavailable', { error: err.message });
      throw err;
    }
  }
  let marked;
  try {
    marked = markToMarket(state, prices);
  } catch (err) {
    if (err instanceof MissingPriceError) return recordFailed(db, pool, periodKey, now, 'price_feed_unavailable', { error: err.message });
    throw err;
  }

  // 3. Cash at venue = net capital transferred + trading cash flows.
  const flows = await one<{ net: string }>(
    db,
    `select coalesce(sum(case when kind = 'to_venue' then amount_base else -amount_base end), 0)::text as net
       from public.treasury_transfers where pool_id = $1 and status = 'completed' and kind in ('to_venue', 'from_venue')`,
    [pool.id],
  );
  const cashFixed = baseToFixed(parseBase(flows.net), decimals) + state.tradeCashFlow;
  const cashBase = fixedToBase(cashFixed, decimals);
  const positionsBase = fixedToBase(marked.marketValue, decimals);
  const gavBase = cashBase + positionsBase;
  if (gavBase < 0n) return recordFailed(db, pool, periodKey, now, 'negative_gross_asset_value', { cashBase: cashBase.toString() });

  // 4. Strike NAV.
  const prev = await maybeOne<{ navpu: string; valued_at: Date; realized_pnl_cum_base: string; unrealized_pnl_base: string }>(
    db,
    `select navpu::text, valued_at, realized_pnl_cum_base::text, unrealized_pnl_base::text
       from public.portfolio_valuations where pool_id = $1 and status = 'final' order by valued_at desc limit 1`,
    [pool.id],
  );
  const previousNavpu = prev ? parseFixed(prev.navpu) : pool.inceptionNavpu;
  const elapsedSeconds = prev ? BigInt(Math.max(0, Math.floor((now.getTime() - new Date(prev.valued_at).getTime()) / 1000))) : 0n;

  const assetsAcct = await ensureAccount(db, 'pool_assets', pool.tokenId, { poolId: pool.id });
  const equityAcct = await ensureAccount(db, 'pool_investor_equity', pool.tokenId, { poolId: pool.id });
  const feesAcct = await ensureAccount(db, 'pool_fees_payable', pool.tokenId, { poolId: pool.id });
  const feesBefore = await cachedBalance(db, feesAcct);

  const unitsRow = await one<{ units: string }>(db, 'select coalesce(sum(units), 0)::text as units from public.investment_positions where pool_id = $1', [pool.id]);
  const unitsOutstanding = parseFixed(unitsRow.units);
  const feePolicy = await currentPolicy(db, 'fee');
  const nav = strikeNav({
    grossAssetValueBase: gavBase,
    feesPayableBeforeBase: feesBefore,
    unitsOutstanding,
    previousNavpu,
    highWaterMark: pool.highWaterMark,
    elapsedSeconds,
    fees: {
      managementFeeBpsPerYear: feePolicy.params.management_fee_bps_per_year,
      performanceFeeBps: feePolicy.params.performance_fee_bps,
      highWaterMark: feePolicy.params.high_water_mark,
    },
  });

  const realizedCumBase = fixedToBase(state.realizedPnl, decimals);
  const unrealizedBase = fixedToBase(marked.unrealizedPnl, decimals);
  const realizedPeriod = realizedCumBase - (prev ? parseBase(prev.realized_pnl_cum_base) : 0n);
  const unrealizedChange = unrealizedBase - (prev ? parseBase(prev.unrealized_pnl_base) : 0n);
  const periodFees = nav.managementFeeBase + nav.performanceFeeBase;

  const valuation = await one<{ id: string }>(
    db,
    `insert into public.portfolio_valuations
       (pool_id, valuation_date, period_key, valued_at, status, cash_base, positions_value_base, gross_asset_value_base,
        fees_accrued_period_base, fees_payable_base, nav_base, units_outstanding, navpu, navpu_previous,
        realized_pnl_cum_base, unrealized_pnl_base, realized_pnl_period_base, unrealized_change_period_base,
        positions, prices, price_source, fee_policy_version_id, is_simulated)
     values ($1, $2::date, $3, $4, 'final', $5, $6, $7, $8, $9, $10, $11::numeric, $12::numeric, $13::numeric,
             $14, $15, $16, $17, $18::jsonb, $19::jsonb, $20, $21, $22)
     returning id`,
    [
      pool.id,
      now.toISOString().slice(0, 10),
      periodKey,
      now,
      cashBase.toString(),
      positionsBase.toString(),
      gavBase.toString(),
      periodFees.toString(),
      nav.feesPayableAfterBase.toString(),
      nav.navBase.toString(),
      fixedToString(unitsOutstanding),
      fixedToString(nav.navpu),
      fixedToString(previousNavpu),
      realizedCumBase.toString(),
      unrealizedBase.toString(),
      realizedPeriod.toString(),
      unrealizedChange.toString(),
      JSON.stringify(
        marked.positions.map((p) => ({
          symbol: p.symbol,
          quantity: fixedToString(p.quantity),
          costBasis: fixedToString(p.costBasis),
          mark: fixedToString(p.mark),
          marketValue: fixedToString(p.marketValue),
          unrealizedPnl: fixedToString(p.unrealizedPnl),
          realizedPnl: fixedToString(p.realizedPnl),
        })),
      ),
      JSON.stringify(Object.fromEntries([...prices].map(([k, v]) => [k, fixedToString(v)]))),
      priceSource,
      feePolicy.id,
      pool.isSimulated,
    ],
  );

  // 5. Ledger: bring pool assets to GAV, accrue fees.
  const entryIds: string[] = [];
  const postedBy = `${actor.type}:${actor.id}`;
  const assetsBefore = await cachedBalance(db, assetsAcct);
  const delta = gavBase - assetsBefore;
  if (delta !== 0n) {
    const lines: LedgerLine[] =
      delta > 0n
        ? [
            { accountId: assetsAcct, direction: 'D', amount: delta },
            { accountId: equityAcct, direction: 'C', amount: delta },
          ]
        : [
            { accountId: equityAcct, direction: 'D', amount: -delta },
            { accountId: assetsAcct, direction: 'C', amount: -delta },
          ];
    entryIds.push(
      await postEntry(db, {
        idempotencyKey: `valuation:${valuation.id}:mtm`,
        eventType: 'pool_mark_to_market',
        sourceType: 'portfolio_valuation',
        sourceId: valuation.id,
        description: `${pool.isSimulated ? '[SIMULATED] ' : ''}Mark-to-market ${pool.code} ${periodKey}`,
        postedBy,
        lines,
        metadata: { realizedPeriod: realizedPeriod.toString(), unrealizedChange: unrealizedChange.toString() },
      }),
    );
  }
  if (periodFees > 0n) {
    entryIds.push(
      await postEntry(db, {
        idempotencyKey: `valuation:${valuation.id}:fees`,
        eventType: 'pool_fee_accrual',
        sourceType: 'portfolio_valuation',
        sourceId: valuation.id,
        description: `Fee accrual ${pool.code} ${periodKey} (policy v${feePolicy.version})`,
        postedBy,
        lines: [
          { accountId: equityAcct, direction: 'D', amount: periodFees, memo: `mgmt ${nav.managementFeeBase} perf ${nav.performanceFeeBase}` },
          { accountId: feesAcct, direction: 'C', amount: periodFees },
        ],
      }),
    );
  }
  const equityAfter = await cachedBalance(db, equityAcct);
  if (equityAfter !== nav.navBase) {
    throw new ValuationIntegrityError(`Pool equity ${equityAfter} != NAV ${nav.navBase} for ${pool.code}`);
  }

  // 6. Allocate the period result to holders (units held through the period).
  const holders = await many<{ user_id: string; units: string }>(
    db,
    'select user_id, units::text from public.investment_positions where pool_id = $1 and units > 0',
    [pool.id],
  );
  const allocations = allocatePeriod(
    holders.map((h) => ({ userId: h.user_id, units: parseFixed(h.units) })),
    previousNavpu,
    nav.navpu,
    { realizedBase: realizedPeriod, unrealizedChangeBase: unrealizedChange, feesBase: periodFees },
  );
  for (const a of allocations) {
    await db.query(
      `insert into public.performance_allocations
         (valuation_id, pool_id, user_id, units_held, navpu_start, navpu_end, pnl_base, realized_share_base, unrealized_share_base, fees_share_base, is_simulated)
       values ($1, $2, $3, $4::numeric, $5::numeric, $6::numeric, $7, $8, $9, $10, $11)`,
      [
        valuation.id,
        pool.id,
        a.userId,
        fixedToString(a.units),
        fixedToString(previousNavpu),
        fixedToString(nav.navpu),
        a.pnlBase.toString(),
        a.realizedShareBase.toString(),
        a.unrealizedShareBase.toString(),
        a.feesShareBase.toString(),
        pool.isSimulated,
      ],
    );
  }
  if (nav.highWaterMark !== pool.highWaterMark) {
    await db.query('update public.investment_pools set high_water_mark = $2::numeric where id = $1', [pool.id, fixedToString(nav.highWaterMark)]);
  }

  // 7. Execute pending orders at the new NAV per unit.
  const executed = await executePendingOrders(db, pool, valuation.id, nav.navpu, now, actor, { assetsAcct, equityAcct });
  await db.query('update public.portfolio_valuations set journal_entry_ids = $2::bigint[] where id = $1', [valuation.id, [...entryIds, ...executed.entryIds]]);
  await recordAudit(db, actor, 'valuation.finalized', { type: 'portfolio_valuation', id: valuation.id }, {
    periodKey,
    navpu: fixedToString(nav.navpu),
    gavBase,
    feesBase: periodFees,
    executedOrders: executed.count,
  });
  return { status: 'final', valuationId: valuation.id, navpu: nav.navpu, executedOrders: executed.count };
}

async function executePendingOrders(
  db: Db,
  pool: PoolInfo,
  valuationId: string,
  navpu: bigint,
  strikeAt: Date,
  actor: Actor,
  accts: { assetsAcct: string; equityAcct: string },
): Promise<{ count: number; entryIds: string[] }> {
  const orders = await many<{ id: string; user_id: string; kind: 'subscription' | 'redemption'; amount_base: string | null; units: string | null }>(
    db,
    `select id, user_id, kind, amount_base::text, units::text from public.investment_orders
      where pool_id = $1 and status = 'pending' and requested_at <= $2 order by requested_at, id for update`,
    [pool.id, strikeAt],
  );
  const treasury = await ensureAccount(db, 'treasury_hot', pool.tokenId);
  const postedBy = `${actor.type}:${actor.id}`;
  const entryIds: string[] = [];

  for (const o of orders) {
    if (o.kind === 'subscription') {
      const amount = parseBase(o.amount_base);
      const units = unitsForAmount(amount, navpu);
      const pending = await ensureAccount(db, 'user_pending_subscription', pool.tokenId, { userId: o.user_id });
      const cash = await ensureAccount(db, 'user_cash', pool.tokenId, { userId: o.user_id });
      if (units === 0n) {
        // Too small to issue a single base unit of units: refund to cash.
        entryIds.push(
          await postEntry(db, {
            idempotencyKey: `order:${o.id}:refund`,
            eventType: 'subscription_refunded',
            sourceType: 'investment_order',
            sourceId: o.id,
            description: 'Subscription too small to issue units; refunded',
            postedBy,
            lines: [
              { accountId: pending, direction: 'D', amount },
              { accountId: cash, direction: 'C', amount },
            ],
          }),
        );
        await db.query("update public.investment_orders set status = 'cancelled', executed_at = $2 where id = $1", [o.id, strikeAt]);
        continue;
      }
      const entryId = await postEntry(db, {
        idempotencyKey: `order:${o.id}:execute`,
        eventType: 'subscription_executed',
        sourceType: 'investment_order',
        sourceId: o.id,
        description: `${pool.isSimulated ? '[SIMULATED venue] ' : ''}Subscription executed at NAV/unit`,
        postedBy,
        lines: [
          { accountId: pending, direction: 'D', amount, memo: 'customer subscription' },
          { accountId: accts.equityAcct, direction: 'C', amount },
          { accountId: accts.assetsAcct, direction: 'D', amount, memo: 'capital to venue' },
          { accountId: treasury, direction: 'C', amount },
        ],
        metadata: { navpu: fixedToString(navpu), units: fixedToString(units) },
      });
      entryIds.push(entryId);
      await db.query(
        `insert into public.investment_positions (pool_id, user_id, units, cost_basis_base) values ($1, $2, $3::numeric, $4)
         on conflict (pool_id, user_id) do update set units = investment_positions.units + excluded.units,
           cost_basis_base = investment_positions.cost_basis_base + excluded.cost_basis_base`,
        [pool.id, o.user_id, fixedToString(units), amount.toString()],
      );
      await db.query(
        "update public.investment_orders set status = 'executed', units = $2::numeric, navpu = $3::numeric, valuation_id = $4, execute_entry_id = $5, executed_at = $6 where id = $1",
        [o.id, fixedToString(units), fixedToString(navpu), valuationId, entryId, strikeAt],
      );
      await recordTransfer(db, pool, 'to_venue', amount, entryId, o.id);
    } else {
      const units = parseFixed(o.units!);
      const pos = await one<{ units: string; cost_basis_base: string }>(
        db,
        'select units::text, cost_basis_base::text from public.investment_positions where pool_id = $1 and user_id = $2 for update',
        [pool.id, o.user_id],
      );
      const held = parseFixed(pos.units);
      const cashOut = unitsValue(units, navpu);
      const released = costBasisReleased(parseBase(pos.cost_basis_base), units, held);
      let entryId: string | null = null;
      if (cashOut > 0n) {
        const cash = await ensureAccount(db, 'user_cash', pool.tokenId, { userId: o.user_id });
        entryId = await postEntry(db, {
          idempotencyKey: `order:${o.id}:execute`,
          eventType: 'redemption_executed',
          sourceType: 'investment_order',
          sourceId: o.id,
          description: `${pool.isSimulated ? '[SIMULATED venue] ' : ''}Redemption executed at NAV/unit`,
          postedBy,
          lines: [
            { accountId: accts.equityAcct, direction: 'D', amount: cashOut, memo: 'units redeemed' },
            { accountId: cash, direction: 'C', amount: cashOut },
            { accountId: treasury, direction: 'D', amount: cashOut, memo: 'capital from venue' },
            { accountId: accts.assetsAcct, direction: 'C', amount: cashOut },
          ],
          metadata: { navpu: fixedToString(navpu), units: fixedToString(units) },
        });
        entryIds.push(entryId);
        await recordTransfer(db, pool, 'from_venue', cashOut, entryId, o.id);
      }
      await db.query(
        `update public.investment_positions set units = units - $3::numeric, units_locked = units_locked - $3::numeric,
           cost_basis_base = cost_basis_base - $4 where pool_id = $1 and user_id = $2`,
        [pool.id, o.user_id, fixedToString(units), released.toString()],
      );
      await db.query(
        `update public.investment_orders set status = 'executed', amount_base = $2, navpu = $3::numeric, valuation_id = $4,
           execute_entry_id = $5, executed_at = $6, realized_pnl_base = $7, cost_basis_released_base = $8 where id = $1`,
        [o.id, cashOut > 0n ? cashOut.toString() : null, fixedToString(navpu), valuationId, entryId, strikeAt, (cashOut - released).toString(), released.toString()],
      );
      await notify(db, { userId: o.user_id, kind: 'redemption_executed', payload: { orderId: o.id, amountBase: cashOut.toString() }, dedupeKey: `redemption:${o.id}` });
    }
  }
  return { count: orders.length, entryIds };
}

/**
 * Record capital moving between treasury and the venue. For a simulated venue
 * the transfer is virtual (no tokens move on chain); reconciliation accounts
 * for that explicitly. A real venue requires a custody transfer workflow.
 */
async function recordTransfer(db: Db, pool: PoolInfo, kind: 'to_venue' | 'from_venue', amount: bigint, entryId: string, orderId: string): Promise<void> {
  if (!pool.isSimulated) {
    throw new Error('Real venue capital transfers require the custody transfer workflow, which is not implemented');
  }
  await db.query(
    `insert into public.treasury_transfers (kind, token_id, pool_id, amount_base, status, is_virtual, journal_entry_id, source_type, source_id, completed_at)
     values ($1, $2, $3, $4, 'completed', true, $5, 'investment_order', $6, now())
     on conflict (source_type, source_id, kind) do nothing`,
    [kind, pool.tokenId, pool.id, amount.toString(), entryId, orderId],
  );
}
