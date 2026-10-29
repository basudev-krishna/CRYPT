import Link from 'next/link';
import { Money } from '@/components/ui/money';
import { Notice, PageHeader } from '@/components/ui/primitives';
import { usdFixed } from '@/server/referrals/program-math';

/** Volumes are 18-dp fixed point in US dollars. */
export const Usd = ({ value }: { value: bigint | string }) => <Money value={value} decimals={18} symbol="USD" />;

export function Progress({ bps, label }: { bps: number; label: string }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(bps / 100)}>
      <div className={`h-full rounded-full ${bps >= 10_000 ? 'bg-gain' : 'bg-accent'}`} style={{ width: `${Math.min(bps, 10_000) / 100}%` }} />
    </div>
  );
}

export const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;

export const share = (have: bigint, need: string) => {
  const n = usdFixed(need);
  return n === 0n || have >= n ? 10_000 : Number(((have < 0n ? 0n : have) * 10_000n) / n);
};

/** Page header shared by the Rank and Matching bonus tabs, with the payouts-off notice. */
export function RewardsHeader({ title, payoutsOn, what }: { title: string; payoutsOn: boolean; what: string }) {
  return (
    <>
      <PageHeader title={title} actions={<Link className="text-sm font-medium text-accent hover:underline" href="/api/rewards/statement">Download statement (CSV)</Link>} />
      {!payoutsOn ? (
        <div className="mb-6">
          <Notice tone="info" title="Program information only">
            {what} payouts are not switched on yet. Your progress is tracked so you can see it; the rates and bonuses below are provisional settings.
          </Notice>
        </div>
      ) : null}
    </>
  );
}
