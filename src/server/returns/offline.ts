/**
 * Daily returns settled offline (see docs/daily-returns.md).
 *
 * Most members hand their principal to the company's team offline and are
 * paid offline. The platform keeps the record and the member's display:
 *   - a team member opens an offline subscription (principal off the ledger,
 *     never withdrawable here, never in custody solvency);
 *   - returns accrue on the ledger like any other (what the company owes);
 *   - a team member records an offline payment of a member's due returns
 *     through a date: D return_payable / C return_cost per accrual. Nothing is
 *     credited to available balance and nothing is shown as an on-chain payment.
 * Offline subscriptions are never paid from the on-chain reserve, so a return
 * can't be paid twice. Every staff action needs a reference or note, is
 * audited and raises a high-severity alert (named when it is for themselves).
 */
import { many, maybeOne, one, type Db } from '../db-core';
import { parseBase, parseUnits } from '@/lib/money';
import { ensureAccount, postEntry, transfer } from '../ledger/ledger';
import { getToken } from '../chains/registry';
import { getAccountStatus } from '../compliance/compliance';
import { notify, raiseRiskEvent, recordAudit, type Actor } from '../ops';
import { ReturnsError, type PlanRow } from './service';
import { utcDate } from './math';

async function alert(db: Db, kind: string, subjectType: string, subjectId: string, userId: string, staffUserId: string, details: Record<string, unknown>) {
  const toSelf = userId === staffUserId;
  await raiseRiskEvent(db, { userId, kind: toSelf ? `${kind}_self` : kind, severity: 'high', subjectType, subjectId, details: { ...details, toSelf } });
}

/** A team member records principal a member handed over offline and opens the plan for them. */
export async function recordOfflineSubscription(
  db: Db,
  args: { userId: string; planId: string; amount: string; reference: string; staffUserId: string; actor: Actor },
): Promise<{ id: string }> {
  const reference = args.reference.trim();
  if (reference.length < 5) throw new ReturnsError('Describe the offline receipt (who received it, when, how)', 'reference_required');
  const p = await maybeOne<PlanRow>(db, 'select id, token_id, status, min_principal_base::text from public.return_plans where id = $1', [args.planId]);
  if (!p || p.status !== 'active') throw new ReturnsError('This plan is not open for subscriptions', 'plan_not_active');
  const token = await getToken(db, Number(p.token_id));
  const amount = parseUnits(args.amount, token.decimals);
  if (amount < parseBase(p.min_principal_base)) throw new ReturnsError('The amount is below the plan minimum', 'below_minimum');
  if ((await getAccountStatus(db, args.userId)) !== 'active') throw new ReturnsError('This member is not active', 'member_not_active');

  const key = `offline-${crypto.randomUUID()}`;
  const row = await one<{ id: string }>(
    db,
    `insert into public.plan_subscriptions (user_id, plan_id, token_id, principal_base, client_key, funding, offline_reference, recorded_by)
     values ($1, $2, $3, $4, $5, 'offline', $6, $7) returning id`,
    [args.userId, p.id, token.id, amount.toString(), key, reference, args.staffUserId],
  );
  const details = { planId: p.id, principalBase: amount.toString(), reference };
  await recordAudit(db, args.actor, 'returns.offline_subscription_recorded', { type: 'plan_subscription', id: row.id }, { ...details, userId: args.userId });
  await alert(db, 'offline_subscription_recorded', 'plan_subscription', row.id, args.userId, args.staffUserId, details);
  return row;
}

/** A team member records that offline principal is being returned offline. Accrual stops that day. */
export async function requestOfflineRedemption(db: Db, args: { subscriptionId: string; note: string; staffUserId: string; actor: Actor }): Promise<void> {
  if (args.note.trim().length < 10) throw new ReturnsError('A note of at least 10 characters is required', 'note_required');
  const s = await maybeOne<{ user_id: string; status: string; funding: string; unlocked: boolean }>(
    db,
    `select s.user_id, s.status, s.funding, coalesce(s.activated_at + make_interval(days => p.principal_lock_days) <= now(), false) as unlocked
       from public.plan_subscriptions s join public.return_plans p on p.id = s.plan_id where s.id = $1 for update of s`,
    [args.subscriptionId],
  );
  if (!s) throw new ReturnsError('Subscription not found', 'not_found');
  if (s.funding !== 'offline') throw new ReturnsError('Only an offline subscription is returned offline; the member redeems an on-platform one', 'not_offline');
  if (s.status !== 'active') throw new ReturnsError('Only an active subscription can be redeemed', 'invalid_state');
  if (!s.unlocked) throw new ReturnsError('The principal is still within the lock period', 'principal_locked');
  await db.query("update public.plan_subscriptions set status = 'redeem_requested', redeem_requested_at = now() where id = $1", [args.subscriptionId]);
  await recordAudit(db, args.actor, 'returns.offline_redemption_recorded', { type: 'plan_subscription', id: args.subscriptionId }, { note: args.note.trim() });
  await alert(db, 'offline_principal_returned', 'plan_subscription', args.subscriptionId, s.user_id, args.staffUserId, { note: args.note.trim() });
}

/** A team member records that a member's due returns, earned up to `throughDate`, were paid offline. */
export async function recordOfflinePayment(
  db: Db,
  args: { userId: string; tokenId: number; throughDate: string; note: string; staffUserId: string; actor: Actor; now?: Date },
): Promise<{ id: string }> {
  const note = args.note.trim();
  if (note.length < 10) throw new ReturnsError('A note of at least 10 characters is required (who paid, how)', 'note_required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.throughDate) || args.throughDate > utcDate(args.now ?? new Date())) throw new ReturnsError('Choose a day that is not in the future', 'invalid_date');
  const due = await dueOffline(db, args.userId, args.tokenId, args.throughDate);
  if (due.count === 0) throw new ReturnsError('Nothing is due for this member up to that day', 'nothing_due');
  const row = await one<{ id: string }>(
    db,
    'insert into public.offline_return_payments (user_id, token_id, through_date, note, recorded_by) values ($1, $2, $3, $4, $5) returning id',
    [args.userId, args.tokenId, args.throughDate, note, args.staffUserId],
  );
  const details = { throughDate: args.throughDate, dueBase: due.amount.toString(), accruals: due.count, note };
  await recordAudit(db, args.actor, 'returns.offline_payment_recorded', { type: 'offline_return_payment', id: row.id }, { ...details, userId: args.userId });
  await alert(db, 'offline_return_payment', 'offline_return_payment', row.id, args.userId, args.staffUserId, details);
  return row;
}

async function dueOffline(db: Db, userId: string, tokenId: number, throughDate: string) {
  const r = await one<{ n: number; s: string }>(
    db,
    `select count(*)::int as n, coalesce(sum(a.amount_base), 0)::text as s
       from public.return_accruals a join public.plan_subscriptions s on s.id = a.subscription_id and s.funding = 'offline'
      where a.user_id = $1 and a.token_id = $2 and a.status = 'payable' and a.accrual_date <= $3::date`,
    [userId, tokenId, throughDate],
  );
  return { count: r.n, amount: parseBase(r.s) };
}

/**
 * Worker: settle the due offline returns a payment covers, oldest first, one
 * ledger entry per accrual (deterministic keys). Returns that became due after
 * the payment was recorded but fall within its date are covered too: the team
 * chose the date. Nothing due means the payment fails rather than posting zero.
 */
export async function postOfflinePayment(db: Db, paymentId: string, actor: Actor): Promise<'posted' | 'failed' | 'unchanged'> {
  const p = await maybeOne<{ id: string; user_id: string; token_id: number; through_date: string; note: string; status: string }>(
    db,
    "select id, user_id, token_id, to_char(through_date, 'YYYY-MM-DD') as through_date, note, status from public.offline_return_payments where id = $1 for update",
    [paymentId],
  );
  if (!p || p.status !== 'pending') return 'unchanged';
  const tokenId = Number(p.token_id);
  const accruals = await many<{ id: string; amount_base: string; accrual_date: string }>(
    db,
    `select a.id, a.amount_base::text, to_char(a.accrual_date, 'YYYY-MM-DD') as accrual_date
       from public.return_accruals a join public.plan_subscriptions s on s.id = a.subscription_id and s.funding = 'offline'
      where a.user_id = $1 and a.token_id = $2 and a.status = 'payable' and a.accrual_date <= $3::date
      order by a.accrual_date, a.id for update of a`,
    [p.user_id, tokenId, p.through_date],
  );
  if (accruals.length === 0) {
    await db.query("update public.offline_return_payments set status = 'failed', error = 'nothing was due up to that day' where id = $1", [p.id]);
    return 'failed';
  }
  const payable = await ensureAccount(db, 'return_payable', tokenId, { userId: p.user_id });
  const cost = await ensureAccount(db, 'return_cost', tokenId);
  let total = 0n;
  for (const a of accruals) {
    const amount = parseBase(a.amount_base);
    const entryId = await postEntry(db, {
      idempotencyKey: `return_accrual:${a.id}:offline`,
      eventType: 'return_paid_offline',
      sourceType: 'return_accrual',
      sourceId: String(a.id),
      description: `Daily return for ${a.accrual_date} paid offline by the team (not an on-chain payment)`,
      postedBy: `${actor.type}:${actor.id}`,
      lines: transfer(payable, cost, amount),
      metadata: { accrualDate: a.accrual_date, offlinePaymentId: p.id },
    });
    await db.query("update public.return_accruals set status = 'settled', settle_entry_id = $2, settled_at = now(), offline_payment_id = $3 where id = $1", [a.id, entryId, p.id]);
    total += amount;
  }
  await db.query("update public.offline_return_payments set status = 'posted', amount_base = $2, accruals = $3, posted_at = now(), error = null where id = $1", [p.id, total.toString(), accruals.length]);
  await notify(db, { userId: p.user_id, kind: 'returns_paid_offline', payload: { paymentId: p.id, amountBase: total.toString(), throughDate: p.through_date }, dedupeKey: `offline_return_payment:${p.id}` });
  await recordAudit(db, actor, 'returns.offline_payment_posted', { type: 'offline_return_payment', id: p.id }, { amountBase: total.toString(), accruals: accruals.length });
  return 'posted';
}

export async function listPendingOfflinePaymentIds(db: Db): Promise<string[]> {
  return (await many<{ id: string }>(db, "select id from public.offline_return_payments where status = 'pending' order by created_at limit 200")).map((r) => r.id);
}

/** Per member: offline principal, and what is accrued and due on offline plans. */
export async function offlineMembers(db: Db) {
  return many<{
    user_id: string;
    member_code: string;
    name: string | null;
    token_id: number;
    symbol: string;
    decimals: number;
    principal: string;
    accrued: string;
    due: string;
    paid: string;
    last_paid_through: string | null;
  }>(
    db,
    `select s.user_id, u.member_code, coalesce(u.display_name, u.username, u.email) as name, s.token_id, t.symbol, t.decimals,
            coalesce(sum(s.principal_base) filter (where s.status in ('active', 'redeem_requested')), 0)::text as principal,
            coalesce((select sum(a.amount_base) from public.return_accruals a join public.plan_subscriptions x on x.id = a.subscription_id and x.funding = 'offline'
                       where a.user_id = s.user_id and a.token_id = s.token_id and a.status = 'accrued'), 0)::text as accrued,
            coalesce((select sum(a.amount_base) from public.return_accruals a join public.plan_subscriptions x on x.id = a.subscription_id and x.funding = 'offline'
                       where a.user_id = s.user_id and a.token_id = s.token_id and a.status = 'payable'), 0)::text as due,
            coalesce((select sum(a.amount_base) from public.return_accruals a where a.user_id = s.user_id and a.token_id = s.token_id and a.offline_payment_id is not null), 0)::text as paid,
            (select to_char(max(o.through_date), 'YYYY-MM-DD') from public.offline_return_payments o where o.user_id = s.user_id and o.token_id = s.token_id and o.status = 'posted') as last_paid_through
       from public.plan_subscriptions s
       join public.user_profiles u on u.user_id = s.user_id
       join public.supported_tokens t on t.id = s.token_id
      where s.funding = 'offline' and s.status not in ('failed', 'cancelled')
      group by s.user_id, u.member_code, u.display_name, u.username, u.email, s.token_id, t.symbol, t.decimals
      order by u.member_code`,
  );
}

export async function listOfflinePayments(db: Db, userId?: string) {
  return many<{ id: string; user_id: string; member_code: string; through_date: string; note: string; status: string; amount_base: string | null; accruals: number | null; created_at: Date; error: string | null; symbol: string; decimals: number }>(
    db,
    `select o.id, o.user_id, u.member_code, to_char(o.through_date, 'YYYY-MM-DD') as through_date, o.note, o.status, o.amount_base::text, o.accruals, o.created_at, o.error, t.symbol, t.decimals
       from public.offline_return_payments o join public.user_profiles u on u.user_id = o.user_id join public.supported_tokens t on t.id = o.token_id
      where ($1::uuid is null or o.user_id = $1) order by o.created_at desc limit 200`,
    [userId ?? null],
  );
}
