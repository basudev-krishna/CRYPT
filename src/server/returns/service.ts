/**
 * Fixed daily returns: a contractual obligation accrued daily on principal and
 * paid only from business revenue (see docs/daily-returns.md).
 *
 * Accounting
 *   subscribe:      D user_cash        C plan_principal
 *   accrue (day):   D return_cost      C return_accrued
 *   becomes due:    D return_accrued   C return_payable
 *   settle:         D return_payable   C user_cash   and   D return_reserve  C return_cost
 *   principal back: D plan_principal   C user_cash
 * The reserve is funded only by allocations of kind 'business_revenue' and can
 * never go negative, so a return is never paid from another member's principal.
 * Accrued and payable returns are promises, not money: they are never
 * withdrawable. Settled returns become available balance, and leave the
 * wallet only through the normal (manually signed, chain-verified) withdrawal.
 *
 * The web role records plans, subscription requests and redemption requests;
 * the worker posts every ledger entry. Each step is idempotent: unique rows
 * (subscription + day), deterministic ledger keys and status checks under lock.
 */
import { many, maybeOne, one, type Db } from '../db-core';
import { parseBase, parseUnits } from '@/lib/money';
import { ensureAccount, lockBalance, postEntry, transfer } from '../ledger/ledger';
import { getToken } from '../chains/registry';
import { getAccountStatus } from '../compliance/compliance';
import { isControlEnabled, isSoleAdmin, notify, raiseRiskEvent, recordAudit, type Actor } from '../ops';
import {
  FORMULA,
  accrualStartDate,
  coverageBps,
  dailyAccrual,
  dueAccrualDates,
  effectiveEndDate,
  minPrincipalForNonZero,
  payableOn,
  runwayDays,
  termEndDate,
  utcDate,
} from './math';

export class ReturnsError extends Error {
  override name = 'ReturnsError';
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

const MIN_NOTE = 10;
const postedBy = (a: Actor) => `${a.type}:${a.id}`;
const requireNote = (note: string) => {
  if (note.trim().length < MIN_NOTE) throw new ReturnsError(`A note of at least ${MIN_NOTE} characters is required`, 'note_required');
};

export type Funding = 'platform' | 'offline';

export interface PlanRow {
  id: string;
  name: string;
  token_id: number;
  daily_rate_ppm: number;
  min_principal_base: string;
  term_days: number | null;
  payable_after_days: number;
  principal_lock_days: number;
  terms_reference: string;
  auto_enroll: boolean;
  status: 'draft' | 'active' | 'closed';
  created_by: string;
  created_at: Date;
  activated_by: string | null;
  activated_at: Date | null;
  closed_at: Date | null;
}

const PLAN_COLS = `id, name, token_id, daily_rate_ppm, min_principal_base::text, term_days, payable_after_days, principal_lock_days,
                   terms_reference, auto_enroll, status, created_by, created_at, activated_by, activated_at, closed_at`;

// -----------------------------------------------------------------------------
// Plans (staff)
// -----------------------------------------------------------------------------

export async function createPlan(
  db: Db,
  args: {
    name: string;
    tokenId: number;
    dailyRatePpm: number;
    minPrincipal: string;
    termDays: number | null;
    payableAfterDays: number;
    principalLockDays: number;
    termsReference: string;
    autoEnroll?: boolean;
    staffUserId: string;
    actor: Actor;
  },
): Promise<{ id: string }> {
  const token = await getToken(db, args.tokenId);
  if (token.isNative || token.status !== 'active') throw new ReturnsError('Choose an active stablecoin', 'invalid_token');
  if (!Number.isInteger(args.dailyRatePpm) || args.dailyRatePpm <= 0 || args.dailyRatePpm > 100_000) throw new ReturnsError('The daily rate must be above 0% and at most 10%', 'invalid_rate');
  const min = parseUnits(args.minPrincipal, token.decimals);
  if (min < minPrincipalForNonZero(args.dailyRatePpm)) throw new ReturnsError('The minimum principal is too small to accrue anything per day', 'invalid_minimum');
  if (args.termsReference.trim().length < 5) throw new ReturnsError('Reference the approved written terms (document id or link)', 'terms_required');
  const row = await one<{ id: string }>(
    db,
    `insert into public.return_plans (name, token_id, daily_rate_ppm, min_principal_base, term_days, payable_after_days, principal_lock_days, terms_reference, auto_enroll, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
    [args.name.trim(), token.id, args.dailyRatePpm, min.toString(), args.termDays, args.payableAfterDays, args.principalLockDays, args.termsReference.trim(), args.autoEnroll ?? false, args.staffUserId],
  );
  await recordAudit(db, args.actor, 'returns.plan_created', { type: 'return_plan', id: row.id }, {
    dailyRatePpm: args.dailyRatePpm,
    minPrincipalBase: min.toString(),
    termDays: args.termDays,
    payableAfterDays: args.payableAfterDays,
    principalLockDays: args.principalLockDays,
    termsReference: args.termsReference.trim(),
    autoEnroll: args.autoEnroll ?? false,
  });
  return row;
}

/**
 * Activating a plan creates obligations, so the activator must not be its
 * creator. A sole administrator has no second person: allowed, always alerted.
 */
export async function activatePlan(db: Db, args: { planId: string; note: string; staffUserId: string; actor: Actor }): Promise<void> {
  requireNote(args.note);
  const p = await maybeOne<PlanRow>(db, `select ${PLAN_COLS} from public.return_plans where id = $1 for update`, [args.planId]);
  if (!p) throw new ReturnsError('Plan not found', 'not_found');
  if (p.status !== 'draft') throw new ReturnsError(`This plan is already ${p.status}`, 'invalid_state');
  const self = p.created_by === args.staffUserId;
  if (self && !(await isSoleAdmin(db, args.staffUserId))) throw new ReturnsError('A different administrator must activate a plan you created', 'four_eyes_required');
  if (p.auto_enroll) {
    const other = await maybeOne<{ id: string }>(db, "select id from public.return_plans where token_id = $1 and auto_enroll and status = 'active' and id <> $2", [p.token_id, p.id]);
    if (other) throw new ReturnsError('Another automatic plan is already active for this token; close it first', 'auto_plan_exists');
  }
  await db.query("update public.return_plans set status = 'active', activated_by = $2, activated_at = now(), activation_note = $3 where id = $1", [p.id, args.staffUserId, args.note.trim()]);
  const details = { dailyRatePpm: p.daily_rate_ppm, termsReference: p.terms_reference, note: args.note.trim(), selfActivated: self };
  await recordAudit(db, args.actor, 'returns.plan_activated', { type: 'return_plan', id: p.id }, details);
  await raiseRiskEvent(db, { kind: self ? 'admin_self_plan_activation' : 'return_plan_activated', severity: 'high', subjectType: 'return_plan', subjectId: p.id, details });
}

/** Closing stops new subscriptions; existing ones keep their terms. */
export async function closePlan(db: Db, args: { planId: string; note: string; staffUserId: string; actor: Actor }): Promise<void> {
  requireNote(args.note);
  const res = await db.query(
    "update public.return_plans set status = 'closed', closed_by = $2, closed_at = now(), close_note = $3 where id = $1 and status in ('draft', 'active')",
    [args.planId, args.staffUserId, args.note.trim()],
  );
  if (res.rowCount !== 1) throw new ReturnsError('Only a draft or active plan can be closed', 'invalid_state');
  await recordAudit(db, args.actor, 'returns.plan_closed', { type: 'return_plan', id: args.planId }, { note: args.note.trim() });
}

export async function listPlans(db: Db, opts: { offeredOnly?: boolean } = {}) {
  return many<PlanRow & { symbol: string; decimals: number; subscribers: number }>(
    db,
    `select ${PLAN_COLS.split(',').map((c) => `p.${c.trim()}`).join(', ')}, t.symbol, t.decimals,
            (select count(*)::int from public.plan_subscriptions s where s.plan_id = p.id and s.status in ('active', 'redeem_requested')) as subscribers
       from public.return_plans p join public.supported_tokens t on t.id = p.token_id
      where ($1::boolean is false or p.status = 'active')
      order by p.created_at desc`,
    [opts.offeredOnly ?? false],
  );
}

// -----------------------------------------------------------------------------
// Subscriptions (member requests; worker posts)
// -----------------------------------------------------------------------------

export async function requestSubscription(
  db: Db,
  args: { userId: string; planId: string; amount: string; clientKey: string; actor: Actor },
): Promise<{ id: string }> {
  const p = await maybeOne<PlanRow>(db, `select ${PLAN_COLS} from public.return_plans where id = $1`, [args.planId]);
  if (!p || p.status !== 'active') throw new ReturnsError('This plan is not open for subscriptions', 'plan_not_active');
  const token = await getToken(db, Number(p.token_id));
  const amount = parseUnits(args.amount, token.decimals);
  if (amount < parseBase(p.min_principal_base)) throw new ReturnsError('The amount is below the plan minimum', 'below_minimum');
  if ((await getAccountStatus(db, args.userId)) !== 'active') throw new ReturnsError('Your account is not active', 'member_not_active');

  const inserted = await maybeOne<{ id: string }>(
    db,
    `insert into public.plan_subscriptions (user_id, plan_id, token_id, principal_base, client_key) values ($1, $2, $3, $4, $5)
     on conflict (user_id, client_key) do nothing returning id`,
    [args.userId, p.id, token.id, amount.toString(), args.clientKey],
  );
  if (!inserted) {
    // A retry of the same request returns the original; a different request under the same key is refused.
    const prior = await one<{ id: string; plan_id: string; principal_base: string }>(
      db,
      'select id, plan_id, principal_base::text from public.plan_subscriptions where user_id = $1 and client_key = $2',
      [args.userId, args.clientKey],
    );
    if (prior.plan_id !== p.id || parseBase(prior.principal_base) !== amount) throw new ReturnsError('This request key was already used for a different subscription', 'idempotency_conflict');
    return { id: prior.id };
  }
  await recordAudit(db, args.actor, 'returns.subscription_requested', { type: 'plan_subscription', id: inserted.id }, { planId: p.id, principalBase: amount.toString() });
  return inserted;
}

export async function cancelSubscription(db: Db, args: { userId: string; subscriptionId: string; actor: Actor }): Promise<void> {
  const res = await db.query(
    "update public.plan_subscriptions set status = 'cancelled', error = 'cancelled by member' where id = $1 and user_id = $2 and status = 'pending'",
    [args.subscriptionId, args.userId],
  );
  if (res.rowCount !== 1) throw new ReturnsError('Only a pending subscription can be cancelled', 'invalid_state');
  await recordAudit(db, args.actor, 'returns.subscription_cancelled', { type: 'plan_subscription', id: args.subscriptionId });
}

/** The member asks for their principal back once the plan's lock has passed. Accrual stops that day. */
export async function requestRedemption(db: Db, args: { userId: string; subscriptionId: string; actor: Actor }): Promise<void> {
  // The database clock decides the lock, exactly as the table guard does (no app/DB clock skew).
  const s = await maybeOne<{ status: string; activated_at: Date | null; unlocked: boolean; funding: Funding }>(
    db,
    `select s.status, s.activated_at, s.funding, coalesce(s.activated_at + make_interval(days => p.principal_lock_days) <= now(), false) as unlocked
       from public.plan_subscriptions s join public.return_plans p on p.id = s.plan_id
      where s.id = $1 and s.user_id = $2 for update of s`,
    [args.subscriptionId, args.userId],
  );
  if (!s) throw new ReturnsError('Subscription not found', 'not_found');
  if (s.funding === 'offline') throw new ReturnsError('This principal was handed to the team offline; the team returns it', 'returned_offline');
  if (s.status !== 'active' || !s.activated_at) throw new ReturnsError('Only an active subscription can be redeemed', 'invalid_state');
  if (!s.unlocked) throw new ReturnsError('Your principal is still within the lock period', 'principal_locked');
  await db.query("update public.plan_subscriptions set status = 'redeem_requested', redeem_requested_at = now() where id = $1", [args.subscriptionId]);
  await recordAudit(db, args.actor, 'returns.redemption_requested', { type: 'plan_subscription', id: args.subscriptionId });
}

export type StepOutcome = 'posted' | 'failed' | 'deferred' | 'unchanged';

/**
 * The first day a subscription earns. Normally the day after it opens. An
 * automatic enrolment earns from the day after the money was received, but
 * never before the plan was activated (no promise for days before the plan).
 */
function firstAccrualDay(openedAt: Date, receivedAt: Date | null, plan: PlanRow): string {
  if (!receivedAt) return accrualStartDate(openedAt);
  const afterReceipt = accrualStartDate(new Date(receivedAt));
  const planStart = plan.activated_at ? utcDate(new Date(plan.activated_at)) : afterReceipt;
  return afterReceipt > planStart ? afterReceipt : planStart;
}

/** Worker: move the principal from available cash into the plan, under the balance lock. */
export async function openSubscription(db: Db, subscriptionId: string, actor: Actor): Promise<StepOutcome> {
  const s = await maybeOne<{ id: string; user_id: string; plan_id: string; token_id: number; principal_base: string; status: string; funding: Funding; principal_received_at: Date | null }>(
    db,
    'select id, user_id, plan_id, token_id, principal_base::text, status, funding, principal_received_at from public.plan_subscriptions where id = $1 for update',
    [subscriptionId],
  );
  if (!s || s.status !== 'pending') return 'unchanged';
  const plan = await one<PlanRow>(db, `select ${PLAN_COLS} from public.return_plans where id = $1`, [s.plan_id]);
  const fail = async (error: string) => {
    await db.query("update public.plan_subscriptions set status = 'failed', error = $2 where id = $1", [s.id, error]);
    await notify(db, { userId: s.user_id, kind: 'plan_subscription_failed', payload: { subscriptionId: s.id, error }, dedupeKey: `plan_subscription:${s.id}:failed` });
    return 'failed' as const;
  };
  if (plan.status !== 'active') return fail('the plan closed before the subscription was opened');
  if ((await getAccountStatus(db, s.user_id)) !== 'active') return fail('the account is not active');

  if (s.funding === 'offline') {
    // Principal was handed over offline: nothing moves on the ledger, accrual starts the same way.
    const at = await one<{ now: Date }>(db, 'select now()');
    const start = firstAccrualDay(new Date(at.now), s.principal_received_at, plan);
    await db.query(
      "update public.plan_subscriptions set status = 'active', activated_at = $2, accrual_start_date = $3, accrual_end_date = $4, error = null where id = $1",
      [s.id, at.now, start, termEndDate(start, plan.term_days)],
    );
    await notify(db, { userId: s.user_id, kind: 'plan_subscription_opened', payload: { subscriptionId: s.id, principalBase: s.principal_base, offline: true }, dedupeKey: `plan_subscription:${s.id}:open` });
    await recordAudit(db, actor, 'returns.subscription_opened', { type: 'plan_subscription', id: s.id }, { offline: true, accrualStartDate: start });
    return 'posted';
  }

  const tokenId = Number(s.token_id);
  const amount = parseBase(s.principal_base);
  const cash = await ensureAccount(db, 'user_cash', tokenId, { userId: s.user_id });
  const principal = await ensureAccount(db, 'plan_principal', tokenId, { userId: s.user_id });
  if ((await lockBalance(db, cash)) < amount) return fail('available balance is lower than the principal');

  const entryId = await postEntry(db, {
    idempotencyKey: `plan_subscription:${s.id}:open`,
    eventType: 'plan_subscription_opened',
    sourceType: 'plan_subscription',
    sourceId: s.id,
    description: `Principal committed to ${plan.name}`,
    postedBy: postedBy(actor),
    lines: transfer(cash, principal, amount),
    metadata: { planId: plan.id, dailyRatePpm: plan.daily_rate_ppm },
  });
  const activated = await one<{ activated_at: Date }>(db, 'select now() as activated_at');
  const start = firstAccrualDay(new Date(activated.activated_at), s.principal_received_at, plan);
  await db.query(
    "update public.plan_subscriptions set status = 'active', activated_at = $2, open_entry_id = $3, accrual_start_date = $4, accrual_end_date = $5, error = null where id = $1",
    [s.id, activated.activated_at, entryId, start, termEndDate(start, plan.term_days)],
  );
  await notify(db, { userId: s.user_id, kind: 'plan_subscription_opened', payload: { subscriptionId: s.id, principalBase: s.principal_base }, dedupeKey: `plan_subscription:${s.id}:open` });
  await recordAudit(db, actor, 'returns.subscription_opened', { type: 'plan_subscription', id: s.id }, { entryId, accrualStartDate: start });
  return 'posted';
}

/** Worker: return the principal to available cash after a redemption request. */
export async function redeemSubscription(db: Db, subscriptionId: string, actor: Actor): Promise<StepOutcome> {
  const s = await maybeOne<{
    id: string;
    user_id: string;
    token_id: number;
    principal_base: string;
    status: string;
    accrual_start_date: string;
    accrual_end_date: string | null;
    redeem_requested_at: Date;
    funding: Funding;
  }>(
    db,
    `select id, user_id, token_id, principal_base::text, status, funding, to_char(accrual_start_date, 'YYYY-MM-DD') as accrual_start_date,
            to_char(accrual_end_date, 'YYYY-MM-DD') as accrual_end_date, redeem_requested_at
       from public.plan_subscriptions where id = $1 for update`,
    [subscriptionId],
  );
  if (!s || s.status !== 'redeem_requested') return 'unchanged';
  const tokenId = Number(s.token_id);
  const amount = parseBase(s.principal_base);
  // Redeemed before the first accrued day: an empty window [start, start).
  const requestedEnd = effectiveEndDate(s.accrual_end_date, new Date(s.redeem_requested_at))!;
  const end = requestedEnd < s.accrual_start_date ? s.accrual_start_date : requestedEnd;
  if (s.funding === 'offline') {
    // The team returns offline principal offline; the record only closes the subscription.
    await db.query("update public.plan_subscriptions set status = 'redeemed', redeemed_at = now(), accrual_end_date = $2 where id = $1", [s.id, end]);
    await notify(db, { userId: s.user_id, kind: 'plan_principal_returned', payload: { subscriptionId: s.id, principalBase: s.principal_base, offline: true }, dedupeKey: `plan_subscription:${s.id}:redeem` });
    await recordAudit(db, actor, 'returns.principal_returned', { type: 'plan_subscription', id: s.id }, { offline: true });
    return 'posted';
  }
  const entryId = await postEntry(db, {
    idempotencyKey: `plan_subscription:${s.id}:redeem`,
    eventType: 'plan_principal_returned',
    sourceType: 'plan_subscription',
    sourceId: s.id,
    description: 'Principal returned to available balance',
    postedBy: postedBy(actor),
    lines: transfer(await ensureAccount(db, 'plan_principal', tokenId, { userId: s.user_id }), await ensureAccount(db, 'user_cash', tokenId, { userId: s.user_id }), amount),
  });
  await db.query("update public.plan_subscriptions set status = 'redeemed', redeemed_at = now(), redeem_entry_id = $2, accrual_end_date = $3 where id = $1", [s.id, entryId, end]);
  await notify(db, { userId: s.user_id, kind: 'plan_principal_returned', payload: { subscriptionId: s.id, principalBase: s.principal_base }, dedupeKey: `plan_subscription:${s.id}:redeem` });
  await recordAudit(db, actor, 'returns.principal_returned', { type: 'plan_subscription', id: s.id }, { entryId });
  return 'posted';
}

// -----------------------------------------------------------------------------
// Daily accrual, maturity and settlement (worker)
// -----------------------------------------------------------------------------

/**
 * Accrue every finished UTC day not yet accrued for one subscription, oldest
 * first. Missed days (worker down, pause) are caught up; a day is never
 * accrued twice (unique row, deterministic ledger key).
 */
export async function accrueSubscription(db: Db, subscriptionId: string, actor: Actor, now: Date = new Date()): Promise<number> {
  if (await isControlEnabled(db, 'return_accruals_paused')) return 0;
  const s = await maybeOne<{
    id: string;
    user_id: string;
    plan_id: string;
    token_id: number;
    principal_base: string;
    status: string;
    start: string | null;
    end: string | null;
    redeem_requested_at: Date | null;
    last: string | null;
  }>(
    db,
    `select s.id, s.user_id, s.plan_id, s.token_id, s.principal_base::text, s.status,
            to_char(s.accrual_start_date, 'YYYY-MM-DD') as start, to_char(s.accrual_end_date, 'YYYY-MM-DD') as "end", s.redeem_requested_at,
            (select to_char(max(a.accrual_date), 'YYYY-MM-DD') from public.return_accruals a where a.subscription_id = s.id) as last
       from public.plan_subscriptions s where s.id = $1 for update`,
    [subscriptionId],
  );
  if (!s || !s.start || !['active', 'redeem_requested', 'redeemed'].includes(s.status)) return 0;
  const plan = await one<PlanRow>(db, `select ${PLAN_COLS} from public.return_plans where id = $1`, [s.plan_id]);
  const end = effectiveEndDate(s.end, s.redeem_requested_at ? new Date(s.redeem_requested_at) : null);
  const dates = dueAccrualDates({ start: s.start, end, lastAccrued: s.last, today: utcDate(now) });
  if (dates.length === 0) return 0;

  const tokenId = Number(s.token_id);
  const principal = parseBase(s.principal_base);
  const amount = dailyAccrual(principal, plan.daily_rate_ppm);
  const cost = await ensureAccount(db, 'return_cost', tokenId);
  const accrued = await ensureAccount(db, 'return_accrued', tokenId, { userId: s.user_id });
  for (const date of dates) {
    const entryId = await postEntry(db, {
      idempotencyKey: `return_accrual:${s.id}:${date}`,
      eventType: 'return_accrual',
      sourceType: 'plan_subscription',
      sourceId: s.id,
      description: `Daily return accrued for ${date} (not yet paid)`,
      postedBy: postedBy(actor),
      lines: transfer(cost, accrued, amount),
      metadata: { accrualDate: date, principalBase: principal.toString(), dailyRatePpm: plan.daily_rate_ppm, planId: plan.id, formula: FORMULA },
    });
    await db.query(
      `insert into public.return_accruals (subscription_id, user_id, token_id, plan_id, accrual_date, principal_base, daily_rate_ppm, amount_base, payable_on, accrual_entry_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) on conflict (subscription_id, accrual_date) do nothing`,
      [s.id, s.user_id, tokenId, plan.id, date, principal.toString(), plan.daily_rate_ppm, amount.toString(), payableOn(date, plan.payable_after_days), entryId],
    );
  }
  return dates.length;
}

/** Subscriptions that may still have days to accrue. */
export async function listAccruingSubscriptionIds(db: Db): Promise<string[]> {
  const rows = await many<{ id: string }>(
    db,
    `select s.id from public.plan_subscriptions s
      where s.status in ('active', 'redeem_requested', 'redeemed') and s.accrual_start_date is not null
        and (s.accrual_end_date is null
             or coalesce((select max(a.accrual_date) from public.return_accruals a where a.subscription_id = s.id), s.accrual_start_date - 1) < s.accrual_end_date - 1)
      order by s.activated_at limit 1000`,
  );
  return rows.map((r) => r.id);
}

/** Move accruals whose payable date has come from accrued to payable. Returns how many moved. */
export async function matureAccruals(db: Db, actor: Actor, now: Date = new Date(), limit = 500): Promise<number> {
  const due = await many<{ id: string; user_id: string; token_id: number; amount_base: string; accrual_date: string }>(
    db,
    `select id, user_id, token_id, amount_base::text, to_char(accrual_date, 'YYYY-MM-DD') as accrual_date from public.return_accruals
      where status = 'accrued' and payable_on <= $1::date order by payable_on, accrual_date, id limit $2 for update skip locked`,
    [utcDate(now), limit],
  );
  for (const a of due) {
    const tokenId = Number(a.token_id);
    const entryId = await postEntry(db, {
      idempotencyKey: `return_accrual:${a.id}:payable`,
      eventType: 'return_payable',
      sourceType: 'return_accrual',
      sourceId: String(a.id),
      description: `Daily return for ${a.accrual_date} is now due (awaiting revenue funding)`,
      postedBy: postedBy(actor),
      lines: transfer(await ensureAccount(db, 'return_accrued', tokenId, { userId: a.user_id }), await ensureAccount(db, 'return_payable', tokenId, { userId: a.user_id }), parseBase(a.amount_base)),
    });
    await db.query("update public.return_accruals set status = 'payable', payable_entry_id = $2, payable_at = now() where id = $1", [a.id, entryId]);
  }
  return due.length;
}

/** The unfunded cost must equal accrued + payable returns; anything else means the books are wrong. */
export async function obligationInvariant(db: Db, tokenId: number): Promise<{ cost: bigint; owed: bigint; ok: boolean }> {
  const r = await one<{ cost: string; owed: string }>(
    db,
    `select coalesce(sum(b.balance) filter (where a.purpose = 'return_cost'), 0)::text as cost,
            coalesce(sum(b.balance) filter (where a.purpose in ('return_accrued', 'return_payable')), 0)::text as owed
       from public.ledger_accounts a join public.account_balances b on b.account_id = a.id
      where a.token_id = $1 and a.purpose in ('return_cost', 'return_accrued', 'return_payable')`,
    [tokenId],
  );
  const cost = parseBase(r.cost);
  const owed = parseBase(r.owed);
  return { cost, owed, ok: cost === owed };
}

export interface SettleResult {
  settled: number;
  total: bigint;
  held: 'paused' | 'invariant' | 'shortfall' | null;
}

/**
 * Pay due returns from the revenue reserve, oldest first, whole accruals only.
 * Stops at the first one the reserve can't cover and raises a shortfall
 * event: the promise is never topped up from principal or other money.
 * Accounts that aren't active are skipped (held) without blocking others.
 */
export async function settlePayables(db: Db, tokenId: number, actor: Actor, now: Date = new Date(), limit = 500): Promise<SettleResult> {
  if (await isControlEnabled(db, 'return_settlements_paused')) return { settled: 0, total: 0n, held: 'paused' };
  const reserve = await ensureAccount(db, 'return_reserve', tokenId);
  const cost = await ensureAccount(db, 'return_cost', tokenId);
  // Lock both shared accounts in id order (as post_entry does) so accruals can't interleave.
  const [first, second] = BigInt(reserve) < BigInt(cost) ? [reserve, cost] : [cost, reserve];
  const balances = new Map([[first, await lockBalance(db, first)], [second, await lockBalance(db, second)]]);
  let available = balances.get(reserve)!;

  const inv = await obligationInvariant(db, tokenId);
  if (!inv.ok) {
    await raiseRiskEvent(db, {
      kind: 'return_obligation_mismatch',
      severity: 'critical',
      subjectType: 'token',
      subjectId: String(tokenId),
      details: { returnCost: inv.cost.toString(), accruedPlusPayable: inv.owed.toString() },
    });
    return { settled: 0, total: 0n, held: 'invariant' };
  }

  const payable = await many<{ id: string; user_id: string; amount_base: string; accrual_date: string; account_status: string | null }>(
    db,
    `select a.id, a.user_id, a.amount_base::text, to_char(a.accrual_date, 'YYYY-MM-DD') as accrual_date, p.account_status
       from public.return_accruals a
       join public.plan_subscriptions s on s.id = a.subscription_id and s.funding = 'platform'
       left join public.user_profiles p on p.user_id = a.user_id
      where a.status = 'payable' and a.token_id = $1 order by a.payable_on, a.accrual_date, a.id limit $2 for update of a`,
    [tokenId, limit],
  );
  let settled = 0;
  let total = 0n;
  let held: SettleResult['held'] = null;
  const perUser = new Map<string, bigint>();
  for (const a of payable) {
    if (a.account_status !== 'active') continue;
    const amount = parseBase(a.amount_base);
    if (amount > available) {
      held = 'shortfall';
      const outstanding = payable.filter((p) => p.account_status === 'active').reduce((s, p) => s + parseBase(p.amount_base), 0n) - total;
      const day = utcDate(now);
      const already = await maybeOne<{ id: string }>(
        db,
        "select id from public.risk_events where kind = 'return_reserve_shortfall' and subject_id = $1 and details->>'day' = $2 limit 1",
        [String(tokenId), day],
      );
      if (!already) {
        await raiseRiskEvent(db, {
          kind: 'return_reserve_shortfall',
          severity: 'high',
          subjectType: 'token',
          subjectId: String(tokenId),
          details: { day, reserveBase: available.toString(), payableBase: outstanding.toString(), shortfallBase: (outstanding - available).toString() },
        });
      }
      break;
    }
    const entryId = await postEntry(db, {
      idempotencyKey: `return_accrual:${a.id}:settle`,
      eventType: 'return_settled',
      sourceType: 'return_accrual',
      sourceId: String(a.id),
      description: `Daily return for ${a.accrual_date} paid from business revenue to available balance`,
      postedBy: postedBy(actor),
      lines: [
        ...transfer(await ensureAccount(db, 'return_payable', tokenId, { userId: a.user_id }), await ensureAccount(db, 'user_cash', tokenId, { userId: a.user_id }), amount),
        ...transfer(reserve, cost, amount),
      ],
      metadata: { accrualDate: a.accrual_date, fundedFrom: 'return_reserve' },
    });
    await db.query("update public.return_accruals set status = 'settled', settle_entry_id = $2, settled_at = now() where id = $1", [a.id, entryId]);
    available -= amount;
    total += amount;
    settled++;
    perUser.set(a.user_id, (perUser.get(a.user_id) ?? 0n) + amount);
  }
  for (const [userId, amount] of perUser) {
    await notify(db, { userId, kind: 'returns_settled', payload: { tokenId, amountBase: amount.toString() }, dedupeKey: `returns_settled:${userId}:${tokenId}:${utcDate(now)}:${amount}` });
  }
  return { settled, total, held };
}

export async function listPendingSubscriptionIds(db: Db, status: 'pending' | 'redeem_requested'): Promise<string[]> {
  return (await many<{ id: string }>(db, 'select id from public.plan_subscriptions where status = $1 order by requested_at limit 200', [status])).map((r) => r.id);
}

export async function listReturnTokenIds(db: Db): Promise<number[]> {
  return (await many<{ token_id: number }>(db, "select distinct a.token_id from public.return_accruals a join public.plan_subscriptions s on s.id = a.subscription_id where a.status = 'payable' and s.funding = 'platform'")).map((r) => Number(r.token_id));
}

// -----------------------------------------------------------------------------
// Monitoring
// -----------------------------------------------------------------------------

export interface ReturnsTokenOverview {
  tokenId: number;
  symbol: string;
  decimals: number;
  principal: bigint;
  offlinePrincipal: bigint;
  accrued: bigint;
  payable: bigint;
  reserve: bigint;
  unfundedCost: bigint;
  accruedToDate: bigint;
  settledToDate: bigint;
  revenueToDate: bigint;
  dailyRunRate: bigint;
  next30Days: bigint;
  coverageBps: bigint | null;
  runwayDays: bigint | null;
  invariantOk: boolean;
}

/** Obligations against funding, per token. Settled means credited to available balance, not paid on chain. */
export async function returnsOverview(db: Db): Promise<ReturnsTokenOverview[]> {
  const rows = await many<{
    token_id: number;
    symbol: string;
    decimals: number;
    principal: string;
    accrued: string;
    payable: string;
    reserve: string;
    cost: string;
    accrued_to_date: string;
    settled_to_date: string;
    revenue_to_date: string;
    run_rate: string;
    offline_principal: string;
  }>(
    db,
    `with t as (
       select distinct token_id from public.return_plans
       union select distinct a.token_id from public.ledger_accounts a where a.purpose = 'return_reserve'
     ), bal as (
       select a.token_id, a.purpose, coalesce(sum(b.balance), 0) as s
         from public.ledger_accounts a left join public.account_balances b on b.account_id = a.id
        where a.purpose in ('plan_principal', 'return_accrued', 'return_payable', 'return_reserve', 'return_cost')
        group by a.token_id, a.purpose
     )
     select t.token_id, tok.symbol, tok.decimals,
            coalesce((select s from bal where bal.token_id = t.token_id and purpose = 'plan_principal'), 0)::text as principal,
            coalesce((select s from bal where bal.token_id = t.token_id and purpose = 'return_accrued'), 0)::text as accrued,
            coalesce((select s from bal where bal.token_id = t.token_id and purpose = 'return_payable'), 0)::text as payable,
            coalesce((select s from bal where bal.token_id = t.token_id and purpose = 'return_reserve'), 0)::text as reserve,
            coalesce((select s from bal where bal.token_id = t.token_id and purpose = 'return_cost'), 0)::text as cost,
            coalesce((select sum(amount_base) from public.return_accruals r where r.token_id = t.token_id), 0)::text as accrued_to_date,
            coalesce((select sum(amount_base) from public.return_accruals r where r.token_id = t.token_id and r.status = 'settled'), 0)::text as settled_to_date,
            coalesce((select sum(d.amount_base) from public.allocations al join public.deposits d on d.id = al.deposit_id
                       where al.kind = 'business_revenue' and al.status = 'posted' and d.token_id = t.token_id), 0)::text as revenue_to_date,
            coalesce((select sum(div(s.principal_base * p.daily_rate_ppm, 1000000)) from public.plan_subscriptions s join public.return_plans p on p.id = s.plan_id
                       where s.token_id = t.token_id and s.status = 'active'
                         and (s.accrual_end_date is null or s.accrual_end_date > (now() at time zone 'utc')::date)), 0)::text as run_rate,
            coalesce((select sum(s.principal_base) from public.plan_subscriptions s
                       where s.token_id = t.token_id and s.funding = 'offline' and s.status in ('active', 'redeem_requested')), 0)::text as offline_principal
       from t join public.supported_tokens tok on tok.id = t.token_id
      order by t.token_id`,
  );
  return rows.map((r) => {
    const reserve = parseBase(r.reserve);
    const payable = parseBase(r.payable);
    const accrued = parseBase(r.accrued);
    const runRate = parseBase(r.run_rate);
    const cost = parseBase(r.cost);
    return {
      tokenId: Number(r.token_id),
      symbol: r.symbol,
      decimals: Number(r.decimals),
      principal: parseBase(r.principal),
      offlinePrincipal: parseBase(r.offline_principal),
      accrued,
      payable,
      reserve,
      unfundedCost: cost,
      accruedToDate: parseBase(r.accrued_to_date),
      settledToDate: parseBase(r.settled_to_date),
      revenueToDate: parseBase(r.revenue_to_date),
      dailyRunRate: runRate,
      next30Days: runRate * 30n,
      coverageBps: coverageBps(reserve, payable),
      runwayDays: runwayDays(reserve, payable, runRate),
      invariantOk: cost === accrued + payable,
    };
  });
}

export async function listRevenueRecords(db: Db) {
  return many<{
    allocation_id: string;
    business_line: string;
    period_start: string;
    period_end: string;
    evidence_reference: string;
    created_at: Date;
    status: string;
    amount_base: string;
    symbol: string;
    decimals: number;
    from_address: string;
    tx_hash: string;
  }>(
    db,
    `select r.allocation_id, r.business_line, to_char(r.period_start, 'YYYY-MM-DD') as period_start, to_char(r.period_end, 'YYYY-MM-DD') as period_end,
            r.evidence_reference, r.created_at, al.status, d.amount_base::text, t.symbol, t.decimals, c.from_address, c.tx_hash
       from public.business_revenue_records r
       join public.allocations al on al.id = r.allocation_id
       join public.deposits d on d.id = al.deposit_id
       join public.chain_transactions c on c.id = d.chain_transaction_id
       join public.supported_tokens t on t.id = d.token_id
      order by r.created_at desc limit 100`,
  );
}

export async function adminSubscriptions(db: Db) {
  return many<{
    id: string;
    user_id: string;
    email: string;
    member_code: string | null;
    plan_name: string;
    principal_base: string;
    symbol: string;
    decimals: number;
    status: string;
    activated_at: Date | null;
    accrued_total: string;
    settled_total: string;
    funding: Funding;
    error: string | null;
  }>(
    db,
    `select s.id, s.user_id, u.email, u.member_code, p.name as plan_name, s.principal_base::text, t.symbol, t.decimals, s.status, s.activated_at, s.error, s.funding,
            coalesce((select sum(a.amount_base) from public.return_accruals a where a.subscription_id = s.id), 0)::text as accrued_total,
            coalesce((select sum(a.amount_base) from public.return_accruals a where a.subscription_id = s.id and a.status = 'settled'), 0)::text as settled_total
       from public.plan_subscriptions s
       join public.return_plans p on p.id = s.plan_id
       join public.supported_tokens t on t.id = s.token_id
       left join public.user_profiles u on u.user_id = s.user_id
      order by s.requested_at desc limit 200`,
  );
}

/** Everything a member sees about their own plans. */
export async function memberReturns(db: Db, userId: string) {
  const [subscriptions, accruals, totals] = await Promise.all([
    many<{
      id: string;
      plan_name: string;
      daily_rate_ppm: number;
      principal_base: string;
      symbol: string;
      decimals: number;
      status: string;
      requested_at: Date;
      activated_at: Date | null;
      accrual_start_date: string | null;
      accrual_end_date: string | null;
      principal_lock_days: number;
      unlock_at: Date | null;
      unlocked: boolean;
      funding: Funding;
      error: string | null;
    }>(
      db,
      `select s.id, p.name as plan_name, p.daily_rate_ppm, s.principal_base::text, t.symbol, t.decimals, s.status, s.requested_at, s.activated_at,
              to_char(s.accrual_start_date, 'YYYY-MM-DD') as accrual_start_date, to_char(s.accrual_end_date, 'YYYY-MM-DD') as accrual_end_date,
              p.principal_lock_days, s.activated_at + make_interval(days => p.principal_lock_days) as unlock_at,
              coalesce(s.activated_at + make_interval(days => p.principal_lock_days) <= now(), false) as unlocked, s.funding, s.error
         from public.plan_subscriptions s join public.return_plans p on p.id = s.plan_id join public.supported_tokens t on t.id = s.token_id
        where s.user_id = $1 order by s.requested_at desc`,
      [userId],
    ),
    many<{
      id: string;
      accrual_date: string;
      principal_base: string;
      daily_rate_ppm: number;
      amount_base: string;
      payable_on: string;
      status: 'accrued' | 'payable' | 'settled';
      settled_at: Date | null;
      paid_offline: boolean;
      symbol: string;
      decimals: number;
    }>(
      db,
      `select a.id, (a.offline_payment_id is not null) as paid_offline, to_char(a.accrual_date, 'YYYY-MM-DD') as accrual_date, a.principal_base::text, a.daily_rate_ppm, a.amount_base::text,
              to_char(a.payable_on, 'YYYY-MM-DD') as payable_on, a.status, a.settled_at, t.symbol, t.decimals
         from public.return_accruals a join public.supported_tokens t on t.id = a.token_id
        where a.user_id = $1 order by a.accrual_date desc, a.id desc limit 120`,
      [userId],
    ),
    many<{ token_id: number; symbol: string; decimals: number; principal: string; offline_principal: string; accrued: string; payable: string; settled: string; paid_offline: string; daily: string }>(
      db,
      `select t.id as token_id, t.symbol, t.decimals,
              coalesce((select sum(b.balance) from public.ledger_accounts a join public.account_balances b on b.account_id = a.id
                         where a.user_id = $1 and a.token_id = t.id and a.purpose = 'plan_principal'), 0)::text as principal,
              coalesce((select sum(s.principal_base) from public.plan_subscriptions s
                         where s.user_id = $1 and s.token_id = t.id and s.funding = 'offline' and s.status in ('active', 'redeem_requested')), 0)::text as offline_principal,
              coalesce((select sum(b.balance) from public.ledger_accounts a join public.account_balances b on b.account_id = a.id
                         where a.user_id = $1 and a.token_id = t.id and a.purpose = 'return_accrued'), 0)::text as accrued,
              coalesce((select sum(b.balance) from public.ledger_accounts a join public.account_balances b on b.account_id = a.id
                         where a.user_id = $1 and a.token_id = t.id and a.purpose = 'return_payable'), 0)::text as payable,
              coalesce((select sum(r.amount_base) from public.return_accruals r
                         where r.user_id = $1 and r.token_id = t.id and r.status = 'settled' and r.offline_payment_id is null), 0)::text as settled,
              coalesce((select sum(r.amount_base) from public.return_accruals r
                         where r.user_id = $1 and r.token_id = t.id and r.offline_payment_id is not null), 0)::text as paid_offline,
              coalesce((select sum(div(s.principal_base * p.daily_rate_ppm, 1000000)) from public.plan_subscriptions s join public.return_plans p on p.id = s.plan_id
                         where s.user_id = $1 and s.token_id = t.id and s.status = 'active'
                           and (s.accrual_end_date is null or s.accrual_end_date > (now() at time zone 'utc')::date)), 0)::text as daily
         from public.supported_tokens t
        where exists (select 1 from public.plan_subscriptions s where s.user_id = $1 and s.token_id = t.id)
        order by t.id`,
      [userId],
    ),
  ]);
  return { subscriptions, accruals, totals };
}
