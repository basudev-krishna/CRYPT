/**
 * Unitized NAV accounting (pure functions, no I/O).
 *
 * Representation
 *   units  U: fixed point, 18 decimals            (1 unit = 1e18)
 *   navpu  P: token base units per unit, 18 dp     (1 USDT/unit with 6-dec token = 1e6 * 1e18)
 *   value(U) = floor(U * P / 1e36) base units
 *
 * Rounding policy (allocation policy v1): every conversion rounds DOWN, in
 * favour of the pool, so issuing or redeeming units can never extract value
 * from other unit holders.
 */
import { FIXED_ONE, mulDivDown, mulDivFloorSigned } from '@/lib/money';

const SCALE2 = FIXED_ONE * FIXED_ONE;
const SECONDS_PER_YEAR = 365n * 24n * 3600n;

export function unitsValue(units: bigint, navpu: bigint): bigint {
  return mulDivDown(units, navpu, SCALE2);
}

/** Units issued for a subscription of `amountBase` at `navpu`. */
export function unitsForAmount(amountBase: bigint, navpu: bigint): bigint {
  if (navpu <= 0n) throw new Error('navpu must be positive');
  return mulDivDown(amountBase, SCALE2, navpu);
}

/** navpu = NAV / units. With no units outstanding, the previous navpu carries forward. */
export function navPerUnit(navBase: bigint, units: bigint, previous: bigint): bigint {
  if (units === 0n) return previous;
  if (navBase < 0n) throw new Error('NAV cannot be negative');
  return mulDivDown(navBase, SCALE2, units);
}

export interface FeePolicyParams {
  managementFeeBpsPerYear: number;
  performanceFeeBps: number;
  highWaterMark: boolean;
}

export interface NavInput {
  grossAssetValueBase: bigint;
  feesPayableBeforeBase: bigint;
  unitsOutstanding: bigint;
  previousNavpu: bigint;
  highWaterMark: bigint;
  elapsedSeconds: bigint;
  fees: FeePolicyParams;
}

export interface NavResult {
  managementFeeBase: bigint;
  performanceFeeBase: bigint;
  feesPayableAfterBase: bigint;
  navBase: bigint;
  navpu: bigint;
  highWaterMark: bigint;
}

/**
 * Strike NAV for a period.
 *   management fee = GAV * bps/1e4 * elapsed/year
 *   performance fee = (pre-fee navpu - HWM) * units * bps/1e4, only above the high-water mark
 * Fees are capped so NAV never goes below zero.
 */
export function strikeNav(i: NavInput): NavResult {
  if (i.elapsedSeconds < 0n) throw new Error('elapsedSeconds cannot be negative');
  if (i.unitsOutstanding === 0n) {
    return {
      managementFeeBase: 0n,
      performanceFeeBase: 0n,
      feesPayableAfterBase: i.feesPayableBeforeBase,
      navBase: i.grossAssetValueBase - i.feesPayableBeforeBase,
      navpu: i.previousNavpu,
      highWaterMark: i.highWaterMark,
    };
  }
  const gav = i.grossAssetValueBase > 0n ? i.grossAssetValueBase : 0n;
  const available = gav - i.feesPayableBeforeBase > 0n ? gav - i.feesPayableBeforeBase : 0n;

  let mgmt = mulDivDown(gav * BigInt(i.fees.managementFeeBpsPerYear), i.elapsedSeconds, 10_000n * SECONDS_PER_YEAR);
  if (mgmt > available) mgmt = available;

  const preFeeNav = available - mgmt;
  const preFeeNavpu = navPerUnit(preFeeNav, i.unitsOutstanding, i.previousNavpu);

  let perf = 0n;
  if (i.fees.performanceFeeBps > 0 && i.fees.highWaterMark && preFeeNavpu > i.highWaterMark) {
    const gainPerUnit = preFeeNavpu - i.highWaterMark;
    perf = mulDivDown(unitsValue(i.unitsOutstanding, gainPerUnit), BigInt(i.fees.performanceFeeBps), 10_000n);
  }
  if (perf > preFeeNav) perf = preFeeNav;

  const navBase = preFeeNav - perf;
  const navpu = navPerUnit(navBase, i.unitsOutstanding, i.previousNavpu);
  return {
    managementFeeBase: mgmt,
    performanceFeeBase: perf,
    feesPayableAfterBase: i.feesPayableBeforeBase + mgmt + perf,
    navBase,
    navpu,
    highWaterMark: i.fees.highWaterMark && navpu > i.highWaterMark ? navpu : i.highWaterMark,
  };
}

export interface AllocationHolder {
  userId: string;
  units: bigint;
}

export interface Allocation {
  userId: string;
  units: bigint;
  pnlBase: bigint;
  realizedShareBase: bigint;
  unrealizedShareBase: bigint;
  feesShareBase: bigint;
}

/**
 * Per-holder share of a period's result, for units held through the period.
 * pnl = U * (P_end - P_start) (signed, floored). Realized/unrealized/fee
 * components are allocated pro rata by units; they explain, but do not
 * change, each holder's pnl.
 */
export function allocatePeriod(
  holders: AllocationHolder[],
  navpuStart: bigint,
  navpuEnd: bigint,
  period: { realizedBase: bigint; unrealizedChangeBase: bigint; feesBase: bigint },
): Allocation[] {
  const totalUnits = holders.reduce((s, h) => s + h.units, 0n);
  return holders
    .filter((h) => h.units > 0n)
    .map((h) => ({
      userId: h.userId,
      units: h.units,
      pnlBase: mulDivFloorSigned(h.units, navpuEnd - navpuStart, SCALE2),
      realizedShareBase: totalUnits ? mulDivFloorSigned(period.realizedBase, h.units, totalUnits) : 0n,
      unrealizedShareBase: totalUnits ? mulDivFloorSigned(period.unrealizedChangeBase, h.units, totalUnits) : 0n,
      feesShareBase: totalUnits ? mulDivFloorSigned(period.feesBase, h.units, totalUnits) : 0n,
    }));
}

/** Cost basis released on redeeming `units` out of `unitsHeld` (all of it on a full redemption). */
export function costBasisReleased(costBasis: bigint, units: bigint, unitsHeld: bigint): bigint {
  if (units > unitsHeld) throw new Error('Cannot redeem more units than held');
  if (units === unitsHeld) return costBasis;
  return mulDivDown(costBasis, units, unitsHeld);
}
