import clsx from 'clsx';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card } from '@/components/ui/primitives';

export function Stat({
  label,
  value,
  sub,
  badge,
  icon: Icon,
  emphasis = false,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  badge?: ReactNode;
  icon?: LucideIcon;
  emphasis?: boolean;
}) {
  return (
    <Card
      className={clsx(
        'group relative overflow-hidden [transition:transform_.25s,box-shadow_.3s] hover:-translate-y-0.5',
        emphasis && 'bg-gradient-to-br from-[#7342e2] via-[#8656ee] to-[#a07cf4] text-white ring-0',
      )}
    >
      {emphasis ? <div aria-hidden className="pointer-events-none absolute -right-10 -top-12 h-40 w-40 rounded-full bg-white/15 blur-2xl" /> : null}
      <div className="relative flex items-center justify-between gap-2">
        <p className={clsx('flex items-center gap-2 text-xs font-medium uppercase tracking-wider', emphasis ? 'text-white/80' : 'text-fg-muted')}>
          {Icon ? (
            <span className={clsx('grid h-7 w-7 place-items-center rounded-xl transition-transform group-hover:scale-110', emphasis ? 'bg-white/20 text-white' : 'bg-accent/10 text-accent')}>
              <Icon size={15} aria-hidden />
            </span>
          ) : null}
          {label}
        </p>
        {badge}
      </div>
      <p className={clsx('num relative mt-3 font-heading tracking-tight', emphasis ? 'text-3xl sm:text-[2.1rem]' : 'text-2xl')}>{value}</p>
      {sub ? <div className={clsx('relative mt-1.5 text-xs', emphasis ? 'text-white/80' : 'text-fg-muted')}>{sub}</div> : null}
    </Card>
  );
}
