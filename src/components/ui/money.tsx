import clsx from 'clsx';
import { formatUnits } from '@/lib/money';

/**
 * Amounts arrive as base-unit strings (or bigint on the server) and are
 * formatted with exact integer arithmetic. Never converted to Number.
 */
export function fmt(value: bigint | string, decimals: number, maxFraction = 2): string {
  const v = typeof value === 'bigint' ? value : BigInt(value);
  return formatUnits(v, decimals, { minFraction: 2, maxFraction, grouping: true });
}

export function Money({
  value,
  decimals,
  symbol,
  signed = false,
  colored = false,
  maxFraction = 2,
  className,
}: {
  value: bigint | string;
  decimals: number;
  symbol?: string;
  signed?: boolean;
  colored?: boolean;
  maxFraction?: number;
  className?: string;
}) {
  const v = typeof value === 'bigint' ? value : BigInt(value);
  const sign = signed && v > 0n ? '+' : '';
  return (
    <span className={clsx('num', colored && (v > 0n ? 'text-gain' : v < 0n ? 'text-loss' : 'text-fg-muted'), className)}>
      {sign}
      {fmt(v, decimals, maxFraction)}
      {symbol ? <span className="ml-1 text-[0.8em] font-normal text-fg-subtle">{symbol}</span> : null}
    </span>
  );
}

/** Signed basis points as a percentage string, e.g. 125n -> "+1.25%". */
export function Bps({ value, colored = true }: { value: bigint | string | null; colored?: boolean }) {
  if (value === null) return <span className="text-fg-subtle">—</span>;
  const v = typeof value === 'bigint' ? value : BigInt(value);
  const abs = v < 0n ? -v : v;
  const text = `${v > 0n ? '+' : v < 0n ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}%`;
  return <span className={clsx('num', colored && (v > 0n ? 'text-gain' : v < 0n ? 'text-loss' : 'text-fg-muted'))}>{text}</span>;
}
