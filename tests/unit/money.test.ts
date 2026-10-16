import { describe, expect, it } from 'vitest';
import { AmountError, fixedToString, formatUnits, mulDivFloorSigned, parseFixed, parseUnits } from '../../src/lib/money';

describe('exact amount handling', () => {
  it('parses decimal strings to base units without floating point', () => {
    expect(parseUnits('100', 6)).toBe(100_000000n);
    expect(parseUnits('0.1', 6) + parseUnits('0.2', 6)).toBe(parseUnits('0.3', 6)); // 0.1 + 0.2 === 0.3
    expect(parseUnits('123456789012345678901234567890.123456', 6)).toBe(123456789012345678901234567890123456n);
    expect(parseUnits('1.5', 18)).toBe(1_500000000000000000n);
  });

  it('rejects excess precision and non-decimal input instead of rounding', () => {
    expect(() => parseUnits('1.0000001', 6)).toThrow(AmountError);
    expect(() => parseUnits('1e6', 6)).toThrow(AmountError);
    expect(() => parseUnits('abc', 6)).toThrow(AmountError);
    expect(() => parseUnits('1,000', 6)).toThrow(AmountError);
    expect(() => parseUnits('', 6)).toThrow(AmountError);
  });

  it('formats base units, truncating rather than rounding up', () => {
    expect(formatUnits(100_000000n, 6)).toBe('100.00');
    expect(formatUnits(1_234567n, 6)).toBe('1.234567');
    expect(formatUnits(1_999999n, 6, { maxFraction: 2 })).toBe('1.99');
    expect(formatUnits(-5_500000n, 6)).toBe('-5.50');
    expect(formatUnits(1234567_000000n, 6, { grouping: true })).toBe('1,234,567.00');
  });

  it('round-trips fixed point used for units and NAV', () => {
    expect(fixedToString(parseFixed('1.5'))).toBe('1.500000000000000000');
    expect(parseFixed('-0.25')).toBe(-250000000000000000n);
    expect(parseFixed('1000000.000000000000000000')).toBe(1000000n * 10n ** 18n);
  });

  it('floors signed division toward negative infinity', () => {
    expect(mulDivFloorSigned(-7n, 1n, 2n)).toBe(-4n);
    expect(mulDivFloorSigned(7n, 1n, 2n)).toBe(3n);
  });
});
