import { describe, expect, it } from 'vitest';
import { parseFixed } from '../../src/lib/money';
import { applyExecutions, fixedToBase, markToMarket, MissingPriceError, TradeValidationError, type Execution } from '../../src/server/investment/pnl';
import { allocatePeriod, costBasisReleased, navPerUnit, strikeNav, unitsForAmount, unitsValue } from '../../src/server/investment/nav';

const F = parseFixed;
let seq = 0;
const exec = (side: 'buy' | 'sell', qty: string, price: string, fee = '0', feeAsset = 'TUSDT'): Execution => ({
  externalId: `e${++seq}`,
  symbol: 'SIMETH/TUSDT',
  side,
  quantity: F(qty),
  price: F(price),
  fee: F(fee),
  feeAsset,
  fundingCost: 0n,
  executedAt: new Date(1_700_000_000_000 + seq * 1000),
});

const NAVPU_ONE = 1_000000n * 10n ** 18n; // 1 tUSDT (6 dp) per unit
const UNIT = 10n ** 18n;
const fees0 = { managementFeeBpsPerYear: 0, performanceFeeBps: 0, highWaterMark: true };

describe('position and P&L engine (weighted average cost)', () => {
  it('computes realized P&L including fees', () => {
    const s = applyExecutions([exec('buy', '2', '1000', '2'), exec('sell', '1', '1200', '1.2')], 'TUSDT');
    // cost basis 2002 -> releases 1001 for 1 unit; proceeds 1200 - 1.2
    expect(s.realizedPnl).toBe(F('197.8'));
    expect(s.positions.get('SIMETH/TUSDT')?.quantity).toBe(F('1'));
    expect(s.positions.get('SIMETH/TUSDT')?.costBasis).toBe(F('1001'));
    expect(s.tradeCashFlow).toBe(F('-2002') + F('1198.8'));
    expect(s.fees).toBe(F('3.2'));
  });

  it('marks open positions to market for unrealized P&L, including losses', () => {
    const s = applyExecutions([exec('buy', '1', '1000')], 'TUSDT');
    const up = markToMarket(s, new Map([['SIMETH/TUSDT', F('1100')]]));
    expect(up.unrealizedPnl).toBe(F('100'));
    const down = markToMarket(s, new Map([['SIMETH/TUSDT', F('700')]]));
    expect(down.unrealizedPnl).toBe(F('-300'));
  });

  it('reports base-asset fees at the execution price and takes them out of the quantity, not cash', () => {
    const s = applyExecutions([exec('buy', '1', '1000', '0.001', 'SIMETH')], 'TUSDT');
    expect(s.fees).toBe(F('1'));
    const pos = s.positions.get('SIMETH/TUSDT')!;
    expect(pos.quantity).toBe(F('0.999'));
    expect(pos.costBasis).toBe(F('1000'));
    expect(s.tradeCashFlow).toBe(F('-1000'));
    // Equity is consistent with the venue whatever the mark: 0.999 held + cash.
    const marked = markToMarket(s, new Map([['SIMETH/TUSDT', F('2000')]]));
    expect(marked.marketValue + s.tradeCashFlow).toBe(F('998'));

    // A sell paying its fee in base disposes of quantity + fee.
    const s2 = applyExecutions([exec('buy', '2', '1000'), exec('sell', '1', '1500', '0.01', 'SIMETH')], 'TUSDT');
    expect(s2.positions.get('SIMETH/TUSDT')?.quantity).toBe(F('0.99'));
    expect(s2.tradeCashFlow).toBe(F('-2000') + F('1500'));
    expect(s2.realizedPnl).toBe(F('1500') - F('1010')); // released cost for 1.01 units at 1000
    expect(() => applyExecutions([exec('buy', '1', '1'), exec('sell', '1', '1', '0.1', 'SIMETH')], 'TUSDT')).toThrow(TradeValidationError);
  });

  it('rejects short selling and mismatched quote currencies', () => {
    expect(() => applyExecutions([exec('sell', '1', '1000')], 'TUSDT')).toThrow(TradeValidationError);
    expect(() => applyExecutions([{ ...exec('buy', '1', '1'), symbol: 'SIMETH/USDC' }], 'TUSDT')).toThrow(TradeValidationError);
  });

  it('refuses to value an open position without a price', () => {
    const s = applyExecutions([exec('buy', '1', '1000')], 'TUSDT');
    expect(() => markToMarket(s, new Map())).toThrow(MissingPriceError);
  });

  it('converts fixed point to token base units by flooring', () => {
    expect(fixedToBase(F('1.2345679'), 6)).toBe(1_234567n);
    expect(fixedToBase(F('-1.0000001'), 6)).toBe(-1_000001n);
  });
});

describe('unitized NAV accounting', () => {
  it('issues and values units exactly, rounding in favour of the pool', () => {
    const units = unitsForAmount(100_000000n, NAVPU_ONE);
    expect(units).toBe(100n * UNIT);
    expect(unitsValue(units, NAVPU_ONE)).toBe(100_000000n);
    const navpu = navPerUnit(100_000001n, 3n * UNIT, NAVPU_ONE); // 33.333333(6)/unit
    expect(unitsValue(3n * UNIT, navpu)).toBeLessThanOrEqual(100_000001n);
  });

  it('reflects negative performance in NAV per unit', () => {
    const r = strikeNav({
      grossAssetValueBase: 90_000000n,
      feesPayableBeforeBase: 0n,
      unitsOutstanding: 100n * UNIT,
      previousNavpu: NAVPU_ONE,
      highWaterMark: NAVPU_ONE,
      elapsedSeconds: 86_400n,
      fees: { managementFeeBpsPerYear: 0, performanceFeeBps: 1000, highWaterMark: true },
    });
    expect(r.navBase).toBe(90_000000n);
    expect(r.performanceFeeBase).toBe(0n); // below the high-water mark
    expect(r.navpu).toBe((NAVPU_ONE * 9n) / 10n);
    expect(r.highWaterMark).toBe(NAVPU_ONE);
  });

  it('charges management fees pro rata and performance fees only above the high-water mark', () => {
    const r = strikeNav({
      grossAssetValueBase: 110_000000n,
      feesPayableBeforeBase: 0n,
      unitsOutstanding: 100n * UNIT,
      previousNavpu: NAVPU_ONE,
      highWaterMark: NAVPU_ONE,
      elapsedSeconds: 365n * 86_400n,
      fees: { managementFeeBpsPerYear: 200, performanceFeeBps: 1000, highWaterMark: true },
    });
    expect(r.managementFeeBase).toBe(2_200000n); // 2% of 110
    // pre-fee NAV 107.8 -> gain 7.8 above HWM -> 10% = 0.78
    expect(r.performanceFeeBase).toBe(780000n);
    expect(r.navBase).toBe(110_000000n - 2_200000n - 780000n);
    expect(r.highWaterMark).toBe(r.navpu);
  });

  it('carries NAV per unit forward when no units are outstanding', () => {
    const r = strikeNav({ grossAssetValueBase: 0n, feesPayableBeforeBase: 0n, unitsOutstanding: 0n, previousNavpu: NAVPU_ONE, highWaterMark: NAVPU_ONE, elapsedSeconds: 100n, fees: fees0 });
    expect(r.navpu).toBe(NAVPU_ONE);
  });

  it('allocates period results by units held, losses included', () => {
    const allocs = allocatePeriod(
      [
        { userId: 'a', units: 75n * UNIT },
        { userId: 'b', units: 25n * UNIT },
      ],
      NAVPU_ONE,
      (NAVPU_ONE * 96n) / 100n,
      { realizedBase: -1_000000n, unrealizedChangeBase: -3_000000n, feesBase: 0n },
    );
    expect(allocs.find((a) => a.userId === 'a')?.pnlBase).toBe(-3_000000n);
    expect(allocs.find((a) => a.userId === 'b')?.pnlBase).toBe(-1_000000n);
    expect(allocs.find((a) => a.userId === 'a')?.realizedShareBase).toBe(-750000n);
  });

  it('releases cost basis proportionally and fully on a full redemption', () => {
    expect(costBasisReleased(100n, UNIT, 4n * UNIT)).toBe(25n);
    expect(costBasisReleased(101n, 4n * UNIT, 4n * UNIT)).toBe(101n);
    expect(() => costBasisReleased(100n, 5n * UNIT, 4n * UNIT)).toThrow();
  });
});
