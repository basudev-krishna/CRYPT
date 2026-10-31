/**
 * Pure math for fixed daily returns (see docs/daily-returns.md).
 *
 * Amounts are bigint base units; rates are integer parts per million
 * (0.33% a day = 3300 ppm). Days are UTC calendar dates as 'YYYY-MM-DD'
 * strings, so a calculation never depends on the server's time zone.
 */

export const PPM = 1_000_000n;
export const FORMULA = 'floor(principal_base * daily_rate_ppm / 1000000)';

/** One day's accrual on a principal: simple interest, rounded down to a base unit. */
export function dailyAccrual(principal: bigint, ratePpm: number): bigint {
  if (principal <= 0n) throw new RangeError('principal must be positive');
  if (!Number.isInteger(ratePpm) || ratePpm <= 0) throw new RangeError('rate must be a positive integer (ppm)');
  return (principal * BigInt(ratePpm)) / PPM;
}

/** Smallest principal whose daily accrual is at least one base unit. */
export function minPrincipalForNonZero(ratePpm: number): bigint {
  const r = BigInt(ratePpm);
  return (PPM + r - 1n) / r;
}

/** Parse a percentage such as "0.33" into ppm (3300). Rejects more than 4 decimal places. */
export function percentToPpm(value: string): number {
  const v = value.trim();
  if (!/^\d{1,3}(\.\d{1,4})?$/.test(v)) throw new RangeError('Enter a percentage with at most 4 decimal places');
  const [whole, frac = ''] = v.split('.');
  return Number(whole) * 10_000 + Number(frac.padEnd(4, '0'));
}

/** ppm as a percentage string, e.g. 3300 -> "0.33". */
export function ppmToPercent(ppm: number): string {
  const whole = Math.floor(ppm / 10_000);
  const frac = String(ppm % 10_000).padStart(4, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toMs(date: string): number {
  if (!DATE_RE.test(date)) throw new RangeError(`not a date: ${date}`);
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) throw new RangeError(`not a date: ${date}`);
  return ms;
}

/** The UTC calendar date of an instant. */
export function utcDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Today's UTC date. */
export function todayUtc(): string {
  return utcDate(new Date());
}

export function addDays(date: string, days: number): string {
  return new Date(toMs(date) + days * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((toMs(to) - toMs(from)) / DAY_MS);
}

/** The first accrued day: the day after the subscription was opened. */
export function accrualStartDate(activatedAt: Date): string {
  return addDays(utcDate(activatedAt), 1);
}

/** Exclusive end of the accrual window set by the plan's term, or null when open-ended. */
export function termEndDate(startDate: string, termDays: number | null): string | null {
  return termDays === null ? null : addDays(startDate, termDays);
}

/**
 * Exclusive end of accrual for a subscription: the earliest of the term end and
 * the day after redemption was requested. The request day itself is accrued:
 * a day accrues as soon as it starts, so it may already be recorded.
 */
export function effectiveEndDate(termEnd: string | null, redeemRequestedAt: Date | null): string | null {
  const redeemEnd = redeemRequestedAt ? addDays(utcDate(redeemRequestedAt), 1) : null;
  if (termEnd === null) return redeemEnd;
  if (redeemEnd === null) return termEnd;
  return redeemEnd < termEnd ? redeemEnd : termEnd;
}

/**
 * The days still to accrue, oldest first: from the day after the last accrued
 * day (or the start) up to and including today (a day accrues as soon as it
 * starts, so members see the day's return that day), excluding the end of the
 * window. At most `limit` days.
 */
export function dueAccrualDates(args: { start: string; end: string | null; lastAccrued: string | null; today: string; limit?: number }): string[] {
  const limit = args.limit ?? 400;
  let d = args.lastAccrued === null || args.lastAccrued < args.start ? args.start : addDays(args.lastAccrued, 1);
  const tomorrow = addDays(args.today, 1);
  const stop = args.end !== null && args.end < tomorrow ? args.end : tomorrow;
  const out: string[] = [];
  while (d < stop && out.length < limit) {
    out.push(d);
    d = addDays(d, 1);
  }
  return out;
}

/** The day a return earned on `accrualDate` becomes payable. */
export function payableOn(accrualDate: string, payableAfterDays: number): string {
  return addDays(accrualDate, 1 + payableAfterDays);
}

/** Whether principal may be requested back at `now`. */
export function principalUnlocked(activatedAt: Date, lockDays: number, now: Date): boolean {
  return now.getTime() >= activatedAt.getTime() + lockDays * DAY_MS;
}

/**
 * Strict oldest-first settlement: pay whole accruals in order while the reserve
 * covers them, and stop at the first one it can't cover (never skip ahead to
 * a newer, smaller one). Returns how many to pay and what they total.
 */
export function settlementPrefix(amounts: bigint[], reserve: bigint): { count: number; total: bigint; shortfall: bigint } {
  let total = 0n;
  let count = 0;
  for (const a of amounts) {
    if (total + a > reserve) break;
    total += a;
    count++;
  }
  const outstanding = amounts.reduce((s, a) => s + a, 0n);
  return { count, total, shortfall: outstanding - reserve > 0n ? outstanding - reserve : 0n };
}

/** Reserve as a share of payable returns, in basis points; null when nothing is payable. */
export function coverageBps(reserve: bigint, payable: bigint): bigint | null {
  if (payable <= 0n) return null;
  return (reserve * 10_000n) / payable;
}

/** Days the reserve, after what is already payable, covers at the current daily run rate; null when nothing accrues. */
export function runwayDays(reserve: bigint, payable: bigint, dailyRunRate: bigint): bigint | null {
  if (dailyRunRate <= 0n) return null;
  const free = reserve - payable;
  return free <= 0n ? 0n : free / dailyRunRate;
}
