import { describe, expect, it } from 'vitest';
import { baseToMicro, signedMicro } from '../../src/server/offchain/holdings';

describe('signedMicro', () => {
  it('signs by entry type, in micro-USDT', () => {
    expect(signedMicro('contribution', '100')).toBe(100_000_000n);
    expect(signedMicro('earnings', '0.5')).toBe(500_000n);
    expect(signedMicro('payback', '20')).toBe(-20_000_000n);
    expect(signedMicro('adjustment', '-1.25')).toBe(-1_250_000n);
    expect(signedMicro('adjustment', '3')).toBe(3_000_000n);
  });
  it('rejects zero, minus signs outside adjustments, excess precision and junk', () => {
    expect(() => signedMicro('contribution', '0')).toThrow();
    expect(() => signedMicro('payback', '-5')).toThrow();
    expect(() => signedMicro('earnings', '1.0000001')).toThrow();
    expect(() => signedMicro('contribution', '1e3')).toThrow();
    expect(() => signedMicro('contribution', 'ten')).toThrow();
  });
});

describe('baseToMicro', () => {
  it('converts token base units exactly', () => {
    expect(baseToMicro(5_000_000n, 6)).toBe(5_000_000n);
    expect(baseToMicro(5n * 10n ** 18n, 18)).toBe(5_000_000n);
  });
  it('refuses amounts that would lose precision', () => {
    expect(() => baseToMicro(5n * 10n ** 18n + 1n, 18)).toThrow(/6 decimal/);
  });
});
