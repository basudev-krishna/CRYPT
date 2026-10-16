'use client';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, Bar, BarChart, Cell, ReferenceLine } from 'recharts';

/**
 * Charts receive pre-formatted decimal strings and convert to Number only for
 * plotting pixels. No financial calculation happens here.
 */
export interface ChartPoint {
  t: string; // ISO time
  v: string; // decimal string
}

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit' });

export function ValueChart({ data, label, simulated }: { data: ChartPoint[]; label: string; simulated: boolean }) {
  const points = data.map((d) => ({ t: d.t, v: Number(d.v) }));
  return (
    <figure aria-label={`${label} chart${simulated ? ' (simulated)' : ''}`} className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="vfill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={simulated ? '#b58cff' : '#5b8cff'} stopOpacity={0.28} />
              <stop offset="100%" stopColor={simulated ? '#b58cff' : '#5b8cff'} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#22304d" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="t" tickFormatter={fmtDate} stroke="#6b7896" fontSize={11} tickLine={false} axisLine={false} minTickGap={40} />
          <YAxis stroke="#6b7896" fontSize={11} tickLine={false} axisLine={false} width={64} domain={['auto', 'auto']} />
          <Tooltip
            contentStyle={{ background: '#0f1626', border: '1px solid #22304d', borderRadius: 8, fontSize: 12 }}
            labelFormatter={(v) => new Date(String(v)).toLocaleString()}
            formatter={(v) => [String(v), label]}
          />
          <Area type="monotone" dataKey="v" stroke={simulated ? '#b58cff' : '#5b8cff'} strokeWidth={2} fill="url(#vfill)" isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </figure>
  );
}

export function PnlBars({ data }: { data: ChartPoint[] }) {
  const points = data.map((d) => ({ t: d.t, v: Number(d.v) }));
  return (
    <figure aria-label="Profit and loss per period" className="h-48 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#22304d" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="t" tickFormatter={fmtDate} stroke="#6b7896" fontSize={11} tickLine={false} axisLine={false} minTickGap={40} />
          <YAxis stroke="#6b7896" fontSize={11} tickLine={false} axisLine={false} width={56} />
          <ReferenceLine y={0} stroke="#2e3f63" />
          <Tooltip contentStyle={{ background: '#0f1626', border: '1px solid #22304d', borderRadius: 8, fontSize: 12 }} labelFormatter={(v) => new Date(String(v)).toLocaleString()} />
          <Bar dataKey="v" isAnimationActive={false}>
            {points.map((p, i) => (
              <Cell key={i} fill={p.v >= 0 ? '#2fbf8a' : '#f06a6a'} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </figure>
  );
}
