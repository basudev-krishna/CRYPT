/**
 * Manual balance adjustments, backed by the operator float.
 *
 * For a close group where members sometimes settle with the administrator
 * personally while their balance lives on the platform:
 *   credit (member paid the admin personally):  D operator_float  C user_cash
 *   debit  (admin paid the member personally):   D user_cash       C operator_float
 *
 * The float is operator money the group wallet actually received (allocation
 * kind 'operator_float') and can never go negative, so an adjustment never
 * creates money and reconciliation keeps passing. Nothing is edited in place:
 * a mistake is fixed with a reversal (the opposite adjustment, once), and a
 * pending adjustment can be cancelled.
 *
 * An adjustment may instead draw on the referral reward fund (operator money
 * for referral bonuses the administrator awards). A credit there is income; a
 * debit is an income correction that returns money paid by mistake (a glitch,
 * a double payment) to the fund, so it never lands in the operator's float.
 * Both count against the member's operator-funded earnings, like reversals.
 *
 * The web role records; the worker posts. With a single administrator there
 * is no second approver, so every adjustment needs a reason, is audited, raises
 * a high-severity risk event and notifies the member.
 */
import { many, maybeOne, one, type Db } from '../db-core';
import { parseBase, parseUnits } from '@/lib/money';
import { ensureAccount, lockBalance, postEntry, transfer } from '../ledger/ledger';
import { getToken } from '../chains/registry';
import { isControlEnabled, notify, raiseRiskEvent, recordAudit, type Actor } from '../ops';

export class AdjustmentError extends Error {
  override name = 'AdjustmentError';
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export type Direction = 'credit' | 'debit';
export type Fund = 'operator_float' | 'referral_reward_fund';
const MIN_REASON = 10;

async function alert(db: Db, actor: Actor, staffUserId: string, id: string, details: Record<string, unknown> & { userId: string }) {
  const toSelf = details.userId === staffUserId;
  await recordAudit(db, actor, 'balance.adjustment_created', { type: 'manual_adjustment', id }, { ...details, toSelf });
  await raiseRiskEvent(db, {
    userId: details.userId,
    kind: toSelf ? 'admin_self_adjustment' : 'admin_adjustment',
    severity: 'high',
    subjectType: 'manual_adjustment',
    subjectId: id,
    details: { ...details, toSelf },
  });
}

export async function createAdjustment(
  db: Db,
  args: { userId: string; tokenId: number; direction: Direction; amount: string; reason: string; fund?: Fund; staffUserId: string; actor: Actor },
): Promise<{ id: string }> {
  const fund = args.fund ?? 'operator_float';
  const reason = args.reason.trim();
  if (reason.length < MIN_REASON) throw new AdjustmentError(`A reason of at least ${MIN_REASON} characters is required`, 'reason_required');
  const token = await getToken(db, args.tokenId);
  if (token.isNative || token.status !== 'active') throw new AdjustmentError('Choose an active stablecoin', 'invalid_token');
  const amount = parseUnits(args.amount, token.decimals);
  if (amount <= 0n) throw new AdjustmentError('The amount must be positive', 'invalid_amount');
  const member = await maybeOne<{ account_status: string }>(db, 'select account_status from public.user_profiles where user_id = $1', [args.userId]);
  if (!member) throw new AdjustmentError('Member not found', 'not_found');
  if (member.account_status !== 'active') throw new AdjustmentError(`This account is ${member.account_status}`, 'member_not_active');
  const row = await one<{ id: string }>(
    db,
    `insert into public.manual_adjustments (user_id, token_id, direction, amount_base, reason, fund, created_by)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [args.userId, token.id, args.direction, amount.toString(), reason, fund, args.staffUserId],
  );
  await alert(db, args.actor, args.staffUserId, row.id, { userId: args.userId, direction: args.direction, amountBase: amount.toString(), tokenId: token.id, reason, fund });
  return row;
}

/** Undo a posted adjustment with the opposite one, at most once. */
export async function reverseAdjustment(db: Db, args: { adjustmentId: string; reason: string; staffUserId: string; actor: Actor }): Promise<{ id: string }> {
  const reason = args.reason.trim();
  if (reason.length < MIN_REASON) throw new AdjustmentError(`A reason of at least ${MIN_REASON} characters is required`, 'reason_required');
  const a = await maybeOne<{ user_id: string; token_id: number; direction: Direction; amount_base: string; status: string; reverses_adjustment_id: string | null; fund: Fund }>(
    db,
    'select user_id, token_id, direction, amount_base::text, status, reverses_adjustment_id, fund from public.manual_adjustments where id = $1 for update',
    [args.adjustmentId],
  );
  if (!a) throw new AdjustmentError('Adjustment not found', 'not_found');
  if (a.status !== 'posted') throw new AdjustmentError('Only a posted adjustment can be reversed; cancel a pending one instead', 'invalid_state');
  if (a.reverses_adjustment_id) throw new AdjustmentError('A reversal cannot be reversed; record a new adjustment instead', 'invalid_state');
  const direction: Direction = a.direction === 'credit' ? 'debit' : 'credit';
  let row: { id: string };
  try {
    row = await one<{ id: string }>(
      db,
      `insert into public.manual_adjustments (user_id, token_id, direction, amount_base, reason, reverses_adjustment_id, fund, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [a.user_id, a.token_id, direction, a.amount_base, `Reversal: ${reason}`, args.adjustmentId, a.fund, args.staffUserId],
    );
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new AdjustmentError('This adjustment was already reversed', 'already_reversed');
    throw err;
  }
  await alert(db, args.actor, args.staffUserId, row.id, { userId: a.user_id, direction, amountBase: a.amount_base, tokenId: Number(a.token_id), reason, fund: a.fund, reverses: args.adjustmentId });
  return row;
}

export async function cancelAdjustment(db: Db, args: { adjustmentId: string; reason: string; actor: Actor }): Promise<void> {
  if (args.reason.trim().length < MIN_REASON) throw new AdjustmentError(`A reason of at least ${MIN_REASON} characters is required`, 'reason_required');
  const res = await db.query("update public.manual_adjustments set status = 'cancelled', error = $2 where id = $1 and status = 'pending'", [
    args.adjustmentId,
    `cancelled: ${args.reason.trim()}`,
  ]);
  if (res.rowCount !== 1) throw new AdjustmentError('Only a pending adjustment can be cancelled', 'invalid_state');
  await recordAudit(db, args.actor, 'balance.adjustment_cancelled', { type: 'manual_adjustment', id: args.adjustmentId }, { reason: args.reason.trim() });
}

export type AdjustmentOutcome = 'posted' | 'deferred' | 'failed' | 'unchanged';

/**
 * Worker: post a pending adjustment. A credit waits (with a recorded reason)
 * while the float is too low; a debit the member can no longer cover fails.
 * Idempotent via the status check under lock and the ledger key.
 */
export async function postAdjustment(db: Db, adjustmentId: string, actor: Actor): Promise<AdjustmentOutcome> {
  const a = await maybeOne<{
    id: string;
    user_id: string;
    token_id: number;
    direction: Direction;
    amount_base: string;
    reason: string;
    status: string;
    error: string | null;
    fund: Fund;
    reverses_adjustment_id: string | null;
  }>(
    db,
    'select id, user_id, token_id, direction, amount_base::text, reason, status, error, fund, reverses_adjustment_id from public.manual_adjustments where id = $1 for update',
    [adjustmentId],
  );
  if (!a || a.status !== 'pending') return 'unchanged';
  if (await isControlEnabled(db, 'allocations_paused')) return 'deferred';

  const tokenId = Number(a.token_id);
  const amount = parseBase(a.amount_base);
  const float = await ensureAccount(db, a.fund, tokenId);
  const fundName = a.fund === 'operator_float' ? 'operator float' : 'referral reward fund';
  const cash = await ensureAccount(db, 'user_cash', tokenId, { userId: a.user_id });
  // Lock both balances in a fixed order (lower account id first), like post_entry does.
  const [first, second] = BigInt(float) < BigInt(cash) ? [float, cash] : [cash, float];
  const locked = new Map([[first, await lockBalance(db, first)], [second, await lockBalance(db, second)]]);

  if (a.direction === 'credit' && locked.get(float)! < amount) {
    const reason = `${fundName} is too low; top it up from the group wallet`;
    if (a.error !== reason) {
      await db.query('update public.manual_adjustments set error = $2 where id = $1', [a.id, reason]);
      await raiseRiskEvent(db, { kind: 'adjustment_held', severity: 'medium', subjectType: 'manual_adjustment', subjectId: a.id, details: { reason } });
    }
    return 'deferred';
  }
  if (a.direction === 'debit' && locked.get(cash)! < amount) {
    await db.query("update public.manual_adjustments set status = 'failed', error = 'member available balance is lower than the debit' where id = $1", [a.id]);
    await raiseRiskEvent(db, { userId: a.user_id, kind: 'adjustment_failed', severity: 'medium', subjectType: 'manual_adjustment', subjectId: a.id, details: { amountBase: a.amount_base } });
    return 'failed';
  }

  // A standalone debit from the fund is an income correction; a debit that reverses a bonus stays a bonus event.
  const incomeCorrection = a.fund === 'referral_reward_fund' && a.direction === 'debit' && !a.reverses_adjustment_id;
  const entryId = await postEntry(db, {
    idempotencyKey: `manual_adjustment:${a.id}`,
    eventType: a.fund === 'operator_float' ? 'manual_adjustment' : incomeCorrection ? 'income_correction' : 'referral_bonus',
    sourceType: 'manual_adjustment',
    sourceId: a.id,
    description: `${a.fund === 'operator_float' ? 'Adjusted by administrator' : incomeCorrection ? 'Income corrected by administrator' : 'Referral bonus'}: ${a.reason}`,
    postedBy: `${actor.type}:${actor.id}`,
    lines: a.direction === 'credit' ? transfer(float, cash, amount) : transfer(cash, float, amount),
    metadata: { direction: a.direction, fund: a.fund },
  });
  await db.query("update public.manual_adjustments set status = 'posted', entry_id = $2, posted_at = now(), error = null where id = $1", [a.id, entryId]);
  await notify(db, {
    userId: a.user_id,
    kind: a.direction === 'credit' ? 'balance_credited_by_admin' : 'balance_debited_by_admin',
    payload: { adjustmentId: a.id, amountBase: a.amount_base, reason: a.reason },
    dedupeKey: `manual_adjustment:${a.id}`,
  });
  await recordAudit(db, actor, 'balance.adjustment_posted', { type: 'manual_adjustment', id: a.id }, { entryId });
  return 'posted';
}

export async function listPendingAdjustmentIds(db: Db): Promise<string[]> {
  return (await many<{ id: string }>(db, "select id from public.manual_adjustments where status = 'pending' order by created_at limit 100")).map((r) => r.id);
}

export async function listAdjustments(db: Db, userId: string) {
  return many<{
    id: string;
    direction: Direction;
    amount_base: string;
    symbol: string;
    decimals: number;
    reason: string;
    status: 'pending' | 'posted' | 'failed' | 'cancelled';
    fund: Fund;
    error: string | null;
    created_at: Date;
    posted_at: Date | null;
    reverses_adjustment_id: string | null;
    reversed: boolean;
  }>(
    db,
    `select m.id, m.direction, m.amount_base::text, t.symbol, t.decimals, m.reason, m.status, m.fund, m.error, m.created_at, m.posted_at, m.reverses_adjustment_id,
            exists (select 1 from public.manual_adjustments r where r.reverses_adjustment_id = m.id) as reversed
       from public.manual_adjustments m join public.supported_tokens t on t.id = m.token_id
      where m.user_id = $1 order by m.created_at desc limit 100`,
    [userId],
  );
}

/** Operator float (or referral fund) balance per token that has such an account. */
export async function operatorFloats(db: Db, fund: Fund = 'operator_float') {
  return many<{ token_id: number; symbol: string; decimals: number; balance: string }>(
    db,
    `select t.id as token_id, t.symbol, t.decimals, coalesce(b.balance, 0)::text as balance
       from public.ledger_accounts a
       join public.supported_tokens t on t.id = a.token_id
       left join public.account_balances b on b.account_id = a.id
      where a.purpose = $1::public.account_purpose order by t.id`,
    [fund],
  );
}
