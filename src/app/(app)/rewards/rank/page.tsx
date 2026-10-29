import type { Metadata } from 'next';
import Link from 'next/link';
import { pageUser } from '@/server/http/auth';
import { webDb } from '@/server/db';
import { memberProgramOverview } from '@/server/referrals/program';
import { rankProgress, usdFixed } from '@/server/referrals/program-math';
import { Badge, Card, CardHeader, EmptyState, Mono, Table, Td } from '@/components/ui/primitives';
import { Money } from '@/components/ui/money';
import { ReferralRewardStatus } from '@/components/ui/referral-stage';
import { Stat } from '@/components/app/stat';
import { Progress, RewardsHeader, Usd } from '@/components/app/rewards-parts';
import { dateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Rank' };

export default async function RankPage() {
  const user = await pageUser();
  const o = await memberProgramOverview(webDb(), user.id);
  const { program, volumes: v } = o;
  const progress = rankProgress(v, o.highestRankOrder, program.ranks.levels);
  const achieved = new Map(o.history.map((h) => [h.rank_code, h.achieved_at]));
  const rewards = o.rewards.filter((r) => r.kind !== 'matching');
  return (
    <>
      <RewardsHeader title="Rank" />

      <div className="grid gap-6 md:grid-cols-3">
        <Stat label="Current rank" value={progress.current ?? '—'} emphasis={progress.current !== null} sub={progress.next ? `Next: ${progress.next.code}` : 'Top rank reached'} />
        <Stat label="Ranks reached" value={achieved.size} sub={`of ${program.ranks.levels.length}`} />
        <Stat label="Self investment" value={<Usd value={v.self} />} />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title="Next rank" subtitle={progress.next ? `${progress.next.code}: bonus ${progress.next.bonus} USD` : 'You hold the top rank.'} />
          {progress.next ? (
            <div className="space-y-4">
              {(
                [
                  ['Left team', v.left, progress.next.left, progress.leftBps],
                  ['Right team', v.right, progress.next.right, progress.rightBps],
                  ['Self investment', v.self, progress.next.self, progress.selfBps],
                ] as const
              ).map(([label, have, need, bps]) => (
                <div key={label}>
                  <div className="mb-1 flex justify-between text-sm">
                    <span>{label}</span>
                    <span className="text-fg-muted">
                      <Usd value={have} /> of <Usd value={usdFixed(need)} />
                    </span>
                  </div>
                  <Progress bps={bps} label={label} />
                </div>
              ))}
            </div>
          ) : null}
        </Card>

        <Card>
          <CardHeader title="Your position" subtitle="Who referred you and where you sit in the team are recorded separately. Only an administrator can correct a position." />
          {o.placement ? (
            <p className="text-sm">
              You are in the <strong className="capitalize">{o.placement.side}</strong> team under <Mono>{o.placement.parent_code}</Mono>, since {dateTime(o.placement.placed_at)}.
            </p>
          ) : (
            <EmptyState title="No team position yet">Members who join without a referral id are placed by the administrator.</EmptyState>
          )}
          <p className="mt-4 text-sm">
            <Link className="text-accent hover:underline" href="/referrals">Your referral link and team tree →</Link>
          </p>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader title="Ranks" subtitle="Ranks are reached in order and kept permanently. A rank reached while rank rewards are off is not paid later." />
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
          {program.ranks.levels.map((r) => {
            const at = achieved.get(r.code);
            return (
              <li key={r.code} className={`rounded-2xl p-4 ring-1 ${at ? 'bg-gain/[0.06] ring-gain/30' : 'bg-surface-3/50 ring-black/5'}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-heading text-lg">{r.code}</span>
                  {at ? <Badge tone="success" title={dateTime(at)}>Reached</Badge> : null}
                </div>
                <dl className="mt-3 space-y-1.5 text-sm">
                  {(
                    [
                      ['Left team', r.left],
                      ['Right team', r.right],
                      ['Self investment', r.self],
                      ['Bonus', r.bonus],
                    ] as const
                  ).map(([label, value]) => (
                    <div key={label} className="flex items-baseline justify-between gap-3">
                      <dt className="text-fg-muted">{label}</dt>
                      <dd className="font-medium"><Usd value={usdFixed(value)} /></dd>
                    </div>
                  ))}
                </dl>
              </li>
            );
          })}
        </ul>
      </Card>

      <Card className="mt-6">
        <CardHeader title={`Rank rewards (${rewards.length})`} subtitle="Only paid rewards are in your available balance." />
        <Table head={['Recorded', 'Rank', 'Amount', 'Status', 'Paid']} empty={rewards.length ? null : <EmptyState title="No rank rewards yet" />}>
          {rewards.map((r) => (
            <tr key={r.id}>
              <Td className="text-fg-muted">{dateTime(r.created_at)}</Td>
              <Td>Rank {r.rank_code}</Td>
              <Td><Money value={r.amount_base} decimals={Number(r.decimals)} symbol={r.symbol} /></Td>
              <Td><ReferralRewardStatus status={r.status} /></Td>
              <Td className="text-fg-muted">{r.posted_at ? dateTime(r.posted_at) : '—'}</Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
