/**
 * Exact arithmetic for token amounts and fixed-point values.
 *
 * - Token amounts are bigint base units (e.g. 1 USDT = 1_000_000n with 6 decimals).
 * - Units and NAV-per-unit use 18-decimal fixed point, also as bigint.
 * - JavaScript `number` is never used for money. Conversion helpers reject
 *   ambiguous input instead of rounding silently.
 */

export const FIXED_SCALE = 18;
export const FIXED_ONE = 10n ** 18n;

const DECIMAL_RE = /^(-)?(\d+)(?:\.(\d+))?$/;

export class AmountError extends Error {
  override name = 'AmountError';
}

/** Parse a user-entered decimal string ("12.5") into base units. Rejects excess precision. */
export function parseUnits(value: string, decimals: number): bigint {
  const trimmed = value.trim();
  const match = DECIMAL_RE.exec(trimmed);
  if (!match) throw new AmountError('Amount must be a plain decimal number');
  const [, sign, whole = '0', frac = ''] = match;
  if (frac.length > decimals) {
    throw new AmountError(`Amount has more than ${decimals} decimal places`);
  }
  const base = BigInt(whole + frac.padEnd(decimals, '0'));
  return sign ? -base : base;
}

/** Format base units as a decimal string, trimming trailing zeros down to `minFraction`. */
export function formatUnits(
  value: bigint,
  decimals: number,
  opts: { minFraction?: number; maxFraction?: number; grouping?: boolean } = {},
): string {
  const { minFraction = 2, maxFraction = decimals, grouping = false } = opts;
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  let frac = abs % scale;

  // Truncate (never round up) to maxFraction digits.
  const fracDigits = Math.min(maxFraction, decimals);
  if (fracDigits < decimals) frac = frac / 10n ** BigInt(decimals - fracDigits);
  let fracStr = fracDigits > 0 ? frac.toString().padStart(fracDigits, '0').replace(/0+$/, '') : '';
  if (fracStr.length < minFraction) fracStr = fracStr.padEnd(minFraction, '0');

  let wholeStr = whole.toString();
  if (grouping) wholeStr = wholeStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${wholeStr}${fracStr ? '.' + fracStr : ''}`;
}

/** Parse a decimal string (e.g. from Postgres numeric) into fixed point with the given scale. Truncates toward zero beyond scale. */
export function parseFixed(value: string | number | bigint, scale = FIXED_SCALE): bigint {
  if (typeof value === 'bigint') return value * 10n ** BigInt(scale);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new AmountError('Refusing to parse non-integer number; pass a string');
    return BigInt(value) * 10n ** BigInt(scale);
  }
  const match = DECIMAL_RE.exec(value.trim());
  if (!match) throw new AmountError(`Invalid decimal: ${value}`);
  const [, sign, whole = '0', frac = ''] = match;
  const digits = BigInt(whole + frac.slice(0, scale).padEnd(scale, '0'));
  return sign ? -digits : digits;
}

/** Render fixed point as a full-precision decimal string suitable for Postgres numeric. */
export function fixedToString(value: bigint, scale = FIXED_SCALE): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const s = 10n ** BigInt(scale);
  const whole = abs / s;
  const frac = (abs % s).toString().padStart(scale, '0');
  return `${negative ? '-' : ''}${whole}${scale > 0 ? '.' + frac : ''}`;
}

/** floor(a * b / d) for non-negative operands; throws on negatives to avoid sign-dependent rounding mistakes. */
export function mulDivDown(a: bigint, b: bigint, d: bigint): bigint {
  if (d <= 0n) throw new AmountError('Division by non-positive value');
  if (a < 0n || b < 0n) throw new AmountError('mulDivDown expects non-negative operands');
  return (a * b) / d;
}

/** Signed a * b / d rounded toward negative infinity (floor). */
export function mulDivFloorSigned(a: bigint, b: bigint, d: bigint): bigint {
  if (d <= 0n) throw new AmountError('Division by non-positive value');
  const n = a * b;
  const q = n / d;
  return n < 0n && n % d !== 0n ? q - 1n : q;
}

/** Parse a Postgres numeric(78,0) string into bigint. */
export function parseBase(value: string | null | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  if (!/^-?\d+$/.test(value)) throw new AmountError(`Expected integer base units, got ${value}`);
  return BigInt(value);
}

export function minBig(...values: bigint[]): bigint {
  return values.reduce((m, v) => (v < m ? v : m));
}

export function maxBig(...values: bigint[]): bigint {
  return values.reduce((m, v) => (v > m ? v : m));
}

export function sumBig(values: Iterable<bigint>): bigint {
  let total = 0n;
  for (const v of values) total += v;
  return total;
}
