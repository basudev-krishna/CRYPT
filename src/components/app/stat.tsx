import clsx from 'clsx';
import type { ReactNode } from 'react';
import { Card } from '@/components/ui/primitives';

export function Stat({ label, value, sub, badge, emphasis = false }: { label: string; value: ReactNode; sub?: ReactNode; badge?: ReactNode; emphasis?: boolean }) {
  return (
    <Card className={clsx(emphasis && 'border-accent/40 from-accent/10')}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wider text-fg-muted">{label}</p>
        {badge}
      </div>
      <p className={clsx('mt-2 font-semibold tracking-tight', emphasis ? 'text-3xl' : 'text-2xl')}>{value}</p>
      {sub ? <div className="mt-1 text-xs text-fg-muted">{sub}</div> : null}
    </Card>
  );
}
