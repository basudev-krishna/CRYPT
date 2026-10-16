/**
 * Subscription and redemption orders. Orders are executed at the next NAV
 * strike (forward pricing) by the valuation job, never at request time.
 *
 * Subscription request: D user_cash C user_pending_subscription (funds leave the withdrawable balance)
 * Redemption request:   units are locked on the position (no ledger movement until the strike)
 */
import { maybeOne, one, type Db } from '../db-core';
import { parseFixed, fixedToString } from '@/lib/money';
import { ensureAccount, lockBalance, postEntry, transfer } from '../ledger/ledger';
import { recordAudit, type Actor } from '../ops';
import { getAccountStatus } from '../compliance/compliance';

export class OrderError extends Error {
  override name = 'OrderError';
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export interface PoolInfo {
  id: number;
  code: string;
  name: string;
  tokenId: number;
  isSimulated: boolean;
  venue: string;
  status: string;
  inceptionNavpu: bigint;
  highWaterMark: bigint;
}

interface PoolRow {
  id: number;
  code: string;
  name: string;
  token_id: number;
  is_simulated: boolean;
  venue: string;
  status: string;
  inception_navpu: string;
  high_water_mark: string;
}

const toPool = (r: PoolRow): PoolInfo => ({
  id: Number(r.id),
  code: r.code,
  name: r.name,
  tokenId: Number(r.token_id),
  isSimulated: r.is_simulated,
  venue: r.venue,
  status: r.status,
  inceptionNavpu: parseFixed(r.inception_navpu),
  highWaterMark: parseFixed(r.high_water_mark),
});

const POOL_COLS = 'id, code, name, token_id, is_simulated, venue, status, inception_navpu::text, high_water_mark::text';

export async function getPool(db: Db, poolId: number, lock = false): Promise<PoolInfo> {
  return toPool(await one<PoolRow>(db, `select ${POOL_COLS} from public.investment_pools where id = $1 ${lock ? 'for update' : ''}`, [poolId]));
}

export async function getPoolForToken(db: Db, tokenId: number): Promise<PoolInfo | null> {
  const r = await maybeOne<PoolRow>(db, `select ${POOL_COLS} from public.investment_pools where token_id = $1 and status = 'active' order by id limit 1`, [tokenId]);
  return r ? toPool(r) : null;
}

async function ensurePosition(db: Db, poolId: number, userId: string): Promise<void> {
  await db.query('insert into public.investment_positions (pool_id, user_id) values ($1, $2) on conflict do nothing', [poolId, userId]);
}

/** Move cash into a pending subscription. Idempotent on idempotencyKey. */
export async function requestSubscription(
  db: Db,
  args: { userId: string; poolId: number; tokenId: number; amount: bigint; idempotencyKey: string; actor: Actor },
): Promise<string> {
  const existing = await maybeOne<{ id: string }>(db, 'select id from public.investment_orders where idempotency_key = $1', [args.idempotencyKey]);
  if (existing) return existing.id;
  if (args.amount <= 0n) throw new OrderError('Amount must be positive', 'invalid_amount');
  const pool = await getPool(db, args.poolId);
  if (pool.status !== 'active' || pool.tokenId !== args.tokenId) throw new OrderError('Pool is not accepting subscriptions', 'pool_unavailable');
  if ((await getAccountStatus(db, args.userId)) !== 'active') throw new OrderError('Account is not active', 'account_restricted');

  const cash = await ensureAccount(db, 'user_cash', args.tokenId, { userId: args.userId });
  const pending = await ensureAccount(db, 'user_pending_subscription', args.tokenId, { userId: args.userId });
  const available = await lockBalance(db, cash);
  if (available < args.amount) throw new OrderError('Insufficient available balance', 'insufficient_balance');

  const order = await one<{ id: string }>(
    db,
    `insert into public.investment_orders (pool_id, user_id, kind, amount_base, idempotency_key)
     values ($1, $2, 'subscription', $3, $4) returning id`,
    [args.poolId, args.userId, args.amount.toString(), args.idempotencyKey],
  );
  const entryId = await postEntry(db, {
    idempotencyKey: `subscription:request:${order.id}`,
    eventType: 'subscription_requested',
    sourceType: 'investment_order',
    sourceId: order.id,
    description: 'Funds committed to next NAV strike',
    postedBy: `${args.actor.type}:${args.actor.id}`,
    lines: transfer(cash, pending, args.amount),
  });
  await db.query('update public.investment_orders set request_entry_id = $2 where id = $1', [order.id, entryId]);
  await ensurePosition(db, args.poolId, args.userId);
  await recordAudit(db, args.actor, 'investment.subscription_requested', { type: 'investment_order', id: order.id }, { amountBase: args.amount });
  return order.id;
}

/** Lock units for redemption at the next strike. `units` null = redeem everything not already locked. */
export async function requestRedemption(
  db: Db,
  args: { userId: string; poolId: number; units: bigint | null; idempotencyKey: string; actor: Actor },
): Promise<string> {
  const existing = await maybeOne<{ id: string }>(db, 'select id from public.investment_orders where idempotency_key = $1', [args.idempotencyKey]);
  if (existing) return existing.id;
  const pos = await maybeOne<{ units: string; units_locked: string }>(
    db,
    'select units::text, units_locked::text from public.investment_positions where pool_id = $1 and user_id = $2 for update',
    [args.poolId, args.userId],
  );
  if (!pos) throw new OrderError('No position in this pool', 'no_position');
  const free = parseFixed(pos.units) - parseFixed(pos.units_locked);
  const units = args.units ?? free;
  if (units <= 0n) throw new OrderError('No units available to redeem', 'invalid_amount');
  if (units > free) throw new OrderError('Redemption exceeds available units', 'insufficient_units');

  await db.query('update public.investment_positions set units_locked = units_locked + $3::numeric where pool_id = $1 and user_id = $2', [
    args.poolId,
    args.userId,
    fixedToString(units),
  ]);
  const order = await one<{ id: string }>(
    db,
    `insert into public.investment_orders (pool_id, user_id, kind, units, idempotency_key)
     values ($1, $2, 'redemption', $3::numeric, $4) returning id`,
    [args.poolId, args.userId, fixedToString(units), args.idempotencyKey],
  );
  await recordAudit(db, args.actor, 'investment.redemption_requested', { type: 'investment_order', id: order.id }, { units: fixedToString(units) });
  return order.id;
}

/** Cancel a still-pending order (releases funds or units). */
export async function cancelOrder(db: Db, args: { userId: string; orderId: string; actor: Actor }): Promise<void> {
  const o = await maybeOne<{ id: string; kind: string; status: string; pool_id: number; amount_base: string | null; units: string | null; token_id: number }>(
    db,
    `select o.id, o.kind, o.status, o.pool_id, o.amount_base::text, o.units::text, p.token_id
       from public.investment_orders o join public.investment_pools p on p.id = o.pool_id
      where o.id = $1 and o.user_id = $2 for update of o`,
    [args.orderId, args.userId],
  );
  if (!o) throw new OrderError('Order not found', 'not_found');
  if (o.status !== 'pending') throw new OrderError('Only pending orders can be cancelled', 'invalid_state');

  if (o.kind === 'subscription') {
    const tokenId = Number(o.token_id);
    const cash = await ensureAccount(db, 'user_cash', tokenId, { userId: args.userId });
    const pending = await ensureAccount(db, 'user_pending_subscription', tokenId, { userId: args.userId });
    await postEntry(db, {
      idempotencyKey: `subscription:cancel:${o.id}`,
      eventType: 'subscription_cancelled',
      sourceType: 'investment_order',
      sourceId: o.id,
      description: 'Pending subscription cancelled',
      postedBy: `${args.actor.type}:${args.actor.id}`,
      lines: transfer(pending, cash, BigInt(o.amount_base!)),
    });
  } else {
    await db.query('update public.investment_positions set units_locked = units_locked - $3::numeric where pool_id = $1 and user_id = $2', [
      o.pool_id,
      args.userId,
      o.units,
    ]);
  }
  await db.query("update public.investment_orders set status = 'cancelled' where id = $1", [o.id]);
  await recordAudit(db, args.actor, 'investment.order_cancelled', { type: 'investment_order', id: o.id });
}
