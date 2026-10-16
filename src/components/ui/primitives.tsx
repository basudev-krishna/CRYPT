import clsx from 'clsx';
import Link from 'next/link';
import type { ComponentProps, ReactNode } from 'react';

export function Card({ className, children, ...rest }: ComponentProps<'section'>) {
  return (
    <section
      className={clsx('rounded-[var(--radius-card)] border border-line bg-gradient-to-b from-surface-2/80 to-surface/80 p-5 shadow-[0_1px_0_rgba(255,255,255,0.03)_inset]', className)}
      {...rest}
    >
      {children}
    </section>
  );
}

export function CardHeader({ title, subtitle, action }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-4 flex items-start justify-between gap-4">
      <div>
        <h2 className="text-sm font-semibold tracking-wide text-fg">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-xs text-fg-muted">{subtitle}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 max-w-2xl text-sm text-fg-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex gap-2">{actions}</div> : null}
    </header>
  );
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const variants: Record<Variant, string> = {
  primary: 'bg-accent text-white hover:bg-accent-strong disabled:bg-accent/40',
  secondary: 'border border-line-strong bg-surface-3 text-fg hover:border-accent/60 disabled:opacity-50',
  ghost: 'text-fg-muted hover:text-fg hover:bg-surface-3',
  danger: 'bg-loss/90 text-white hover:bg-loss disabled:opacity-50',
};

export function Button({ variant = 'primary', className, ...rest }: ComponentProps<'button'> & { variant?: Variant }) {
  return (
    <button
      className={clsx('inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors disabled:cursor-not-allowed', variants[variant], className)}
      {...rest}
    />
  );
}

export function ButtonLink({ variant = 'primary', className, ...rest }: ComponentProps<typeof Link> & { variant?: Variant }) {
  return <Link className={clsx('inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors', variants[variant], className)} {...rest} />;
}

export function Field({ label, hint, error, htmlFor, children }: { label: string; hint?: ReactNode; error?: string | null; htmlFor: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-xs font-medium uppercase tracking-wider text-fg-muted">
        {label}
      </label>
      {children}
      {error ? (
        <p role="alert" className="text-xs text-loss">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-fg-subtle">{hint}</p>
      ) : null}
    </div>
  );
}

const inputCls =
  'h-10 w-full rounded-lg border border-line bg-bg/60 px-3 text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none aria-[invalid=true]:border-loss';

export function Input(props: ComponentProps<'input'>) {
  return <input {...props} className={clsx(inputCls, props.className)} />;
}

export function Select(props: ComponentProps<'select'>) {
  return <select {...props} className={clsx(inputCls, 'appearance-none', props.className)} />;
}

export function Textarea(props: ComponentProps<'textarea'>) {
  return <textarea {...props} className={clsx(inputCls, 'h-24 py-2', props.className)} />;
}

export type Tone = 'neutral' | 'info' | 'success' | 'warn' | 'danger' | 'sim';
const tones: Record<Tone, string> = {
  neutral: 'border-line-strong bg-surface-3 text-fg-muted',
  info: 'border-info/30 bg-info/10 text-info',
  success: 'border-gain/30 bg-gain/10 text-gain',
  warn: 'border-warn/30 bg-warn/10 text-warn',
  danger: 'border-loss/30 bg-loss/10 text-loss',
  sim: 'border-sim/40 bg-sim/10 text-sim',
};

export function Badge({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={clsx('inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide', tones[tone])}>
      {children}
    </span>
  );
}

export function SimulatedBadge() {
  return (
    <Badge tone="sim" title="Simulated data from a development trading venue or test network. Not actual investment performance.">
      Simulated
    </Badge>
  );
}

export function Notice({ tone = 'info', title, children }: { tone?: Tone; title?: string; children: ReactNode }) {
  const border = { neutral: 'border-line', info: 'border-info/40', success: 'border-gain/40', warn: 'border-warn/40', danger: 'border-loss/40', sim: 'border-sim/40' }[tone];
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={clsx('rounded-lg border bg-surface/70 px-4 py-3 text-sm', border)}>
      {title ? <p className="mb-0.5 font-medium text-fg">{title}</p> : null}
      <div className="text-fg-muted">{children}</div>
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-line px-6 py-10 text-center">
      <p className="text-sm font-medium text-fg">{title}</p>
      {children ? <div className="mt-1 max-w-sm text-sm text-fg-muted">{children}</div> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={clsx('animate-pulse rounded-md bg-surface-3/70', className)} />;
}

export function Table({ head, children, empty }: { head: ReactNode[]; children: ReactNode; empty?: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead>
          <tr className="border-b border-line text-[11px] uppercase tracking-wider text-fg-subtle">
            {head.map((h, i) => (
              <th key={i} scope="col" className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line/60">{children}</tbody>
      </table>
      {empty}
    </div>
  );
}

export function Td({ className, ...rest }: ComponentProps<'td'>) {
  return <td className={clsx('px-3 py-2.5 align-middle', className)} {...rest} />;
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={clsx('font-mono text-xs text-fg-muted', className)}>{children}</span>;
}

export function shortHash(h: string | null | undefined, n = 8): string {
  if (!h) return '—';
  const s = h.replace(/^sim:/, '');
  return s.length > 2 * n + 2 ? `${s.slice(0, n + 2)}…${s.slice(-n)}` : s;
}
