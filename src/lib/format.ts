export function dateTime(d: Date | string | null | undefined): string {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
}

/** Units are 18-dp fixed point; display with 4 decimals, truncated. */
export function unitsDisplay(units: bigint): string {
  const whole = units / 10n ** 18n;
  const frac = ((units % 10n ** 18n) / 10n ** 14n).toString().padStart(4, '0');
  return `${whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
}

/** navpu (base units per unit, 18 dp) -> token-denominated price string. */
export function navpuDisplay(navpu: bigint, tokenDecimals: number, dp = 6): string {
  const perToken = 10n ** BigInt(18 + tokenDecimals);
  const whole = navpu / perToken;
  const frac = ((navpu % perToken) * 10n ** BigInt(dp)) / perToken;
  return `${whole}.${frac.toString().padStart(dp, '0')}`;
}

/** Decimal string for charts (display only). */
export function baseToChart(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const s = 10n ** BigInt(decimals);
  return `${neg ? '-' : ''}${abs / s}.${(abs % s).toString().padStart(decimals, '0').slice(0, 2)}`;
}
