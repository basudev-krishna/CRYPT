'use client';
import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ReferenceLine, ResponsiveContainer, Sector, Tooltip, XAxis, YAxis } from 'recharts';

/**
 * Charts receive pre-formatted decimal strings and convert to Number only for
 * plotting pixels. No financial calculation happens here.
 */
export interface ChartPoint {
  t: string; // ISO time
  v: string; // decimal string
}

// Recessive chart chrome on the light paper surface; series colours match --color-series-*.
const GRID = '#ece8e1';
const AXIS = '#7d8996';
const ACCENT = '#7342e2';
const SIM = '#8a4fd8';
export const SERIES = ['#7342e2', '#1f9e89', '#e0952a', '#3d7be0'] as const;
const tooltipStyle = { background: '#ffffff', border: '1px solid #e4e0d8', borderRadius: 14, fontSize: 12, boxShadow: '0 12px 32px -12px rgba(25,40,55,0.25)', padding: '8px 12px' };

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const RANGES = [
  { key: '7D', days: 7 },
  { key: '30D', days: 30 },
  { key: '90D', days: 90 },
] as const;
type RangeKey = (typeof RANGES)[number]['key'];

/** Segmented control used above charts (one row, filters before the plot). */
export function RangeTabs<T extends string>({ value, options, onChange, label }: { value: T; options: readonly T[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex rounded-full bg-surface-3 p-1">
      {options.map((o) => (
        <button
          key={o}
          role="tab"
          aria-selected={value === o}
          onClick={() => onChange(o)}
          className={clsx('rounded-full px-3 py-1 text-xs font-medium transition-all', value === o ? 'bg-white text-fg shadow-sm' : 'text-fg-muted hover:text-fg')}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

export function ValueChart({ data, label, simulated, withRanges = false }: { data: ChartPoint[]; label: string; simulated: boolean; withRanges?: boolean }) {
  const [range, setRange] = useState<RangeKey>('90D');
  const points = useMemo(() => {
    const all = data.map((d) => ({ t: d.t, v: Number(d.v) }));
    const last = all[all.length - 1];
    if (!withRanges || !last) return all;
    const days = RANGES.find((r) => r.key === range)?.days ?? 90;
    const cutoff = new Date(last.t).getTime() - days * 86_400_000;
    return all.filter((p) => new Date(p.t).getTime() >= cutoff);
  }, [data, range, withRanges]);
  const color = simulated ? SIM : ACCENT;
  const first = points[0]?.v;
  const lastV = points[points.length - 1]?.v;
  // Display-only percentage for the chart caption; balances are never computed here.
  const change = points.length > 1 && first !== undefined && lastV !== undefined && first !== 0 ? ((lastV - first) / Math.abs(first)) * 100 : null;
  return (
    <div>
      {withRanges ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-fg-muted">
            {change !== null ? (
              <>
                <span className={clsx('font-semibold', change >= 0 ? 'text-gain' : 'text-loss')}>
                  {change >= 0 ? '▲' : '▼'} {Math.abs(change).toFixed(2)}%
                </span>{' '}
                over the last {range.replace('D', ' days')}
              </>
            ) : (
              'Not enough points in this range'
            )}
          </p>
          <RangeTabs value={range} options={RANGES.map((r) => r.key)} onChange={setRange} label="Chart range" />
        </div>
      ) : null}
      <figure aria-label={`${label} chart${simulated ? ' (simulated)' : ''}`} className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="vfill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.22} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="t" tickFormatter={fmtDate} stroke={AXIS} fontSize={11} tickLine={false} axisLine={false} minTickGap={40} />
            <YAxis stroke={AXIS} fontSize={11} tickLine={false} axisLine={false} width={64} domain={['auto', 'auto']} />
            <Tooltip contentStyle={tooltipStyle} cursor={{ stroke: color, strokeWidth: 1 }} labelFormatter={(v) => new Date(String(v)).toLocaleString()} formatter={(v) => [String(v), label]} />
            <Area type="monotone" dataKey="v" stroke={color} strokeWidth={2} fill="url(#vfill)" activeDot={{ r: 5, stroke: '#fff', strokeWidth: 2 }} animationDuration={700} />
          </AreaChart>
        </ResponsiveContainer>
      </figure>
    </div>
  );
}

export function PnlBars({ data }: { data: ChartPoint[] }) {
  const points = data.map((d) => ({ t: d.t, v: Number(d.v) }));
  return (
    <figure aria-label="Profit and loss per period" className="h-48 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="t" tickFormatter={fmtDate} stroke={AXIS} fontSize={11} tickLine={false} axisLine={false} minTickGap={40} />
          <YAxis stroke={AXIS} fontSize={11} tickLine={false} axisLine={false} width={56} />
          <ReferenceLine y={0} stroke="#d3cdc4" />
          <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'rgba(115,66,226,0.06)' }} labelFormatter={(v) => new Date(String(v)).toLocaleString()} />
          <Bar dataKey="v" maxBarSize={24} radius={[4, 4, 0, 0]} animationDuration={600}>
            {points.map((p, i) => (
              <Cell key={i} fill={p.v >= 0 ? '#11865c' : '#d23f3f'} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </figure>
  );
}

/** New accounts per day; `day` is YYYY-MM-DD (UTC). */
export function SignupBars({ data }: { data: { day: string; n: number }[] }) {
  const label = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return (
    <figure aria-label="New sign-ups per day, last 14 days" className="h-44 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="day" tickFormatter={label} stroke={AXIS} fontSize={11} tickLine={false} axisLine={false} minTickGap={24} />
          <YAxis stroke={AXIS} fontSize={11} tickLine={false} axisLine={false} width={28} allowDecimals={false} />
          <Tooltip cursor={{ fill: 'rgba(115,66,226,0.06)' }} contentStyle={tooltipStyle} labelFormatter={(v) => label(String(v))} formatter={(v) => [String(v), 'Sign-ups']} />
          <Bar dataKey="n" fill={ACCENT} maxBarSize={24} radius={[4, 4, 0, 0]} animationDuration={600} />
        </BarChart>
      </ResponsiveContainer>
    </figure>
  );
}

export interface Slice {
  key: string;
  label: string;
  /** Decimal string, plotted only. */
  value: string;
  /** Pre-formatted amount shown in the legend and centre. */
  display: string;
}

/**
 * Donut with a hover-linked legend: hovering a slice or a legend row lifts
 * that slice and shows its amount in the centre. Colours follow the slice's
 * fixed position, never its size.
 */
export function AllocationDonut({ slices, centerLabel, centerValue }: { slices: Slice[]; centerLabel: string; centerValue: string }) {
  const [active, setActive] = useState<number | null>(null);
  const data = slices.map((s, i) => ({ ...s, n: Math.max(Number(s.value), 0), color: SERIES[i % SERIES.length] ?? ACCENT }));
  const total = data.reduce((a, d) => a + d.n, 0);
  const plotted = total > 0 ? data : [{ key: 'empty', label: '', value: '0', display: '', n: 1, color: GRID }];
  const shown = active !== null && total > 0 ? data[active] : undefined;
  return (
    <div className="grid items-center gap-6 sm:grid-cols-[200px_1fr]">
      <figure aria-label="Balance breakdown" className="relative mx-auto h-[200px] w-[200px]">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={plotted}
              dataKey="n"
              innerRadius={66}
              outerRadius={90}
              paddingAngle={data.filter((d) => d.n > 0).length > 1 ? 2 : 0}
              stroke="#ffffff"
              strokeWidth={2}
              cornerRadius={4}
              onMouseEnter={(_, i) => total > 0 && setActive(i)}
              onMouseLeave={() => setActive(null)}
              activeShape={(props: object) => <Sector {...props} outerRadius={(props as { outerRadius: number }).outerRadius + 6} />}
              animationDuration={700}
            >
              {plotted.map((d, i) => (
                <Cell key={d.key} fill={d.color} opacity={active === null || active === i ? 1 : 0.35} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
          <div>
            <p className="text-[11px] uppercase tracking-wider text-fg-muted">{shown ? shown.label : centerLabel}</p>
            <p className="num font-heading text-lg">{shown ? shown.display : centerValue}</p>
            {shown ? <p className="text-xs text-fg-muted">{((shown.n / total) * 100).toFixed(1)}%</p> : null}
          </div>
        </div>
      </figure>
      <ul className="space-y-1">
        {data.map((d, i) => (
          <li key={d.key}>
            <button
              type="button"
              onMouseEnter={() => setActive(i)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(null)}
              className={clsx('flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors', active === i ? 'bg-surface-3' : 'hover:bg-surface-3/60')}
            >
              <span className="flex items-center gap-2.5">
                <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ background: d.color }} />
                {d.label}
              </span>
              <span className="num font-medium">{d.display}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Horizontal share bars for a few named amounts (e.g. the platform position). */
export function ShareBars({ rows }: { rows: { label: string; value: string; display: string }[] }) {
  const nums = rows.map((r) => Math.max(Number(r.value), 0));
  const max = Math.max(...nums, 0);
  return (
    <ul className="space-y-3.5">
      {rows.map((r, i) => {
        const n = nums[i] ?? 0;
        const pct = max > 0 ? Math.max((n / max) * 100, n > 0 ? 2 : 0) : 0;
        return (
          <li key={r.label} className="group">
            <div className="mb-1.5 flex items-baseline justify-between gap-3 text-sm">
              <span className="flex items-center gap-2 text-fg-muted">
                <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ background: SERIES[i % SERIES.length] }} />
                {r.label}
              </span>
              <span className="num font-medium">{r.display}</span>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-surface-3">
              <div className="h-full rounded-full transition-[width] duration-700 ease-out group-hover:brightness-110" style={{ width: `${pct}%`, background: SERIES[i % SERIES.length] }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
