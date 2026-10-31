import { describe, expect, it } from 'vitest';
import {
  accrualStartDate,
  addDays,
  coverageBps,
  dailyAccrual,
  daysBetween,
  dueAccrualDates,
  effectiveEndDate,
  minPrincipalForNonZero,
  payableOn,
  percentToPpm,
  ppmToPercent,
  principalUnlocked,
  runwayDays,
  settlementPrefix,
  termEndDate,
  utcDate,
} from '../../src/server/returns/math';
import { parseUnits } from '../../src/lib/money';

const usdt18 = (v: string) => parseUnits(v, 18);
const usdt6 = (v: string) => parseUnits(v, 6);

describe('daily accrual formula', () => {
  it('is 0.33% of principal, exactly, in base units', () => {
    expect(dailyAccrual(usdt18('1000'), 3300)).toBe(usdt18('3.3'));
    expect(dailyAccrual(usdt6('1000'), 3300)).toBe(usdt6('3.3'));
    expect(dailyAccrual(usdt6('12345.678901'), 3300)).toBe(40_740_740n); // 40.7407403733 -> rounded down
  });

  it('rounds down to one base unit and refuses nonsense', () => {
    expect(dailyAccrual(303n, 3300)).toBe(0n);
    expect(dailyAccrual(304n, 3300)).toBe(1n);
    expect(minPrincipalForNonZero(3300)).toBe(304n);
    expect(() => dailyAccrual(0n, 3300)).toThrow();
    expect(() => dailyAccrual(1n, 0)).toThrow();
    expect(() => dailyAccrual(1n, 1.5)).toThrow();
  });

  it('is simple interest: a year of days is 1.2045 x principal, not compounded', () => {
    const p = usdt6('50000');
    expect(dailyAccrual(p, 3300) * 365n).toBe(usdt6('60225'));
  });
});

describe('rate parsing', () => {
  it('converts percentages to ppm and back without floats', () => {
    expect(percentToPpm('0.33')).toBe(3300);
    expect(percentToPpm('1')).toBe(10_000);
    expect(percentToPpm('0.0001')).toBe(1);
    expect(ppmToPercent(3300)).toBe('0.33');
    expect(ppmToPercent(10_000)).toBe('1');
    expect(() => percentToPpm('0.00001')).toThrow();
    expect(() => percentToPpm('-1')).toThrow();
    expect(() => percentToPpm('1e2')).toThrow();
  });
});

describe('UTC day windows', () => {
  it('starts the day after opening, whatever the hour', () => {
    expect(accrualStartDate(new Date('2026-11-01T00:00:00Z'))).toBe('2026-11-02');
    expect(accrualStartDate(new Date('2026-11-01T23:59:59Z'))).toBe('2026-11-02');
    expect(utcDate(new Date('2026-11-01T23:30:00-05:00'))).toBe('2026-11-02');
  });

  it('handles month, year and leap-day boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(daysBetween('2026-11-02', '2027-11-02')).toBe(365);
  });

  it('ends at the term or after the redemption day, whichever is first', () => {
    expect(termEndDate('2026-11-02', 30)).toBe('2026-12-02');
    expect(termEndDate('2026-11-02', null)).toBeNull();
    expect(effectiveEndDate('2026-12-02', null)).toBe('2026-12-02');
    expect(effectiveEndDate(null, new Date('2026-11-10T08:00:00Z'))).toBe('2026-11-11');
    expect(effectiveEndDate('2026-12-02', new Date('2026-11-10T08:00:00Z'))).toBe('2026-11-11');
    expect(effectiveEndDate('2026-11-05', new Date('2026-11-10T08:00:00Z'))).toBe('2026-11-05');
    expect(effectiveEndDate('2026-11-11', new Date('2026-11-10T23:59:59Z'))).toBe('2026-11-11');
    expect(effectiveEndDate(null, null)).toBeNull();
  });

  it('lists started, unaccrued days (today included) and catches up missed ones', () => {
    expect(dueAccrualDates({ start: '2026-11-02', end: null, lastAccrued: null, today: '2026-11-01' })).toEqual([]);
    expect(dueAccrualDates({ start: '2026-11-02', end: null, lastAccrued: null, today: '2026-11-02' })).toEqual(['2026-11-02']);
    expect(dueAccrualDates({ start: '2026-11-02', end: null, lastAccrued: '2026-11-02', today: '2026-11-02' })).toEqual([]);
    expect(dueAccrualDates({ start: '2026-11-02', end: null, lastAccrued: null, today: '2026-11-05' })).toEqual(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']);
    expect(dueAccrualDates({ start: '2026-11-02', end: null, lastAccrued: '2026-11-03', today: '2026-11-05' })).toEqual(['2026-11-04', '2026-11-05']);
    expect(dueAccrualDates({ start: '2026-11-02', end: null, lastAccrued: '2026-11-05', today: '2026-11-05' })).toEqual([]);
    expect(dueAccrualDates({ start: '2026-11-02', end: '2026-11-04', lastAccrued: null, today: '2026-11-30' })).toEqual(['2026-11-02', '2026-11-03']);
    expect(dueAccrualDates({ start: '2026-11-02', end: '2026-11-02', lastAccrued: null, today: '2026-11-30' })).toEqual([]);
    expect(dueAccrualDates({ start: '2026-11-02', end: null, lastAccrued: null, today: '2027-11-02', limit: 10 })).toHaveLength(10);
  });

  it('makes a day payable the configured number of days after it ends', () => {
    expect(payableOn('2026-11-02', 0)).toBe('2026-11-03');
    expect(payableOn('2026-11-02', 30)).toBe('2026-12-03');
  });

  it('unlocks principal only after the lock period', () => {
    const opened = new Date('2026-11-01T10:00:00Z');
    expect(principalUnlocked(opened, 30, new Date('2026-12-01T09:59:59Z'))).toBe(false);
    expect(principalUnlocked(opened, 30, new Date('2026-12-01T10:00:00Z'))).toBe(true);
    expect(principalUnlocked(opened, 0, opened)).toBe(true);
  });
});

describe('settlement and coverage', () => {
  it('pays oldest first, whole amounts only, and never skips ahead', () => {
    expect(settlementPrefix([5n, 5n, 5n], 12n)).toEqual({ count: 2, total: 10n, shortfall: 3n });
    // The third (1) would fit in what is left, but the second (10) comes first: stop.
    expect(settlementPrefix([5n, 10n, 1n], 12n)).toEqual({ count: 1, total: 5n, shortfall: 4n });
    expect(settlementPrefix([5n, 5n], 100n)).toEqual({ count: 2, total: 10n, shortfall: 0n });
    expect(settlementPrefix([], 0n)).toEqual({ count: 0, total: 0n, shortfall: 0n });
  });

  it('reports coverage and runway without division by zero', () => {
    expect(coverageBps(50n, 100n)).toBe(5000n);
    expect(coverageBps(0n, 100n)).toBe(0n);
    expect(coverageBps(100n, 0n)).toBeNull();
    expect(runwayDays(1000n, 100n, 30n)).toBe(30n);
    expect(runwayDays(50n, 100n, 30n)).toBe(0n);
    expect(runwayDays(1000n, 0n, 0n)).toBeNull();
  });
});
