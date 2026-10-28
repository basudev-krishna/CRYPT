import type { Metadata } from 'next';
import Link from 'next/link';
import { pageUser } from '@/server/http/auth';
import { webDb } from '@/server/db';
import { memberProgramOverview } from '@/server/referrals/program';
import { getDashboard, getRewardIncome } from '@/server/queries/user';
import { rankProgress, usdFixed } from '@/server/referrals/program-math';
import { Badge, Card, CardHeader, EmptyState, Mono, Notice, PageHeader, Table, Td } from '@/components/ui/primitives';
import { Money } from '@/components/ui/money';
import { ReferralRewardStatus } from '@/components/ui/referral-stage';
import { Stat } from '@/components/app/stat';
import { dateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Rank & matching' };

/** Volumes are 18-dp fixed point in US dollars. */
const Usd = ({ value }: { value: bigint | string }) => <Money value={value} decimals={18} symbol="USD" />;

function Progress({ bps, label }: { bps: number; label: string }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(bps / 100)}>
      <div className={`h-full rounded-full ${bps >= 10_000 ? 'bg-gain' : 'bg-accent'}`} style={{ width: `${Math.min(bps, 10_000) / 100}%` }} />
    </div>
  );
}

const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;

const share = (have: bigint, need: string) => {
  const n = usdFixed(need);
  return n === 0n || have >= n ? 10_000 : Number(((have < 0n ? 0n : have) * 10_000n) / n);
};

export default async function RewardsPage() {
  const user = await pageUser();
  const db = webDb();
  const [o, d] = await Promise.all([memberProgramOverview(db, user.id), getDashboard(db, user.id)]);
  const income = d.token ? await getRewardIncome(db, user.id, d.token.id) : 0n;
  const dec = d.token?.decimals ?? 6;
  const sym = d.token?.symbol ?? 'USDT';
  const { program, volumes: v } = o;
  const progress = rankProgress(v, o.highestRankOrder, program.ranks.levels);
  const achieved = new Map(o.history.map((h) => [h.rank_code, h.achieved_at]));
  const sum = (status: string) => o.rewards.filter((r) => r.status === status);
  const payoutsOn = program.matching.enabled || program.ranks.rewards_enabled;
  return (
    <>
      <PageHeader
        title="Rank & matching"
        actions={<Link className="text-sm font-medium text-accent hover:underline" href="/api/rewards/statement">Download statement (CSV)</Link>}
      />
      {!payoutsOn ? (
        <div className="mb-6">
          <Notice tone="info" title="Program information only">
            Matching and rank payouts are not switched on yet. Ranks and volumes are tracked so you can see your progress; the rates and bonuses below are provisional settings.
          </Notice>
        </div>
      ) : null}

      <div className="grid gap-6 md:grid-cols-3">
        <Stat label="Current rank" value={progress.current ?? '—'} emphasis={progress.current !== null} sub={progress.next ? `Next: ${progress.next.code}` : 'Top rank reached'} />
        <Stat label="Left team" value={v.leftCount} sub={<>Volume <Usd value={v.left} /></>} />
        <Stat label="Right team" value={v.rightCount} sub={<>Volume <Usd value={v.right} /></>} />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader
            title="Minimum matching amount"
            subtitle="A threshold on each side's operator-funded volume before matching can pay you. It is not a deposit requirement and not a guarantee of payment."
          />
          <dl className="mb-5 grid gap-3 sm:grid-cols-3">
            {(
              [
                ['Total balance', d.totalAccountValue, 'Your whole account value'],
                ['Total income', income, 'All rewards paid to you'],
                ['Available to withdraw', d.available, 'Ready to withdraw now'],
              ] as const
            ).map(([label, amount, hint]) => (
              <div key={label} className="rounded-xl bg-surface-3/60 p-3 ring-1 ring-black/5">
                <dt className="text-xs text-fg-muted">{label}</dt>
                <dd className="mt-1 text-base font-semibold">
                  <Money value={amount} decimals={dec} symbol={sym} />
                </dd>
                <dd className="mt-0.5 text-[11px] text-fg-subtle">{hint}</dd>
              </div>
            ))}
          </dl>
          {(['left', 'right'] as const).map((side) => {
            const have = v[side];
            const need = side === 'left' ? program.matching.min_left : program.matching.min_right;
            const bps = share(have, need);
            return (
              <div key={side} className="mb-4">
                <div className="mb-1 flex justify-between text-sm">
                  <span className="capitalize">{side} team</span>
                  <span className="text-fg-muted">
                    <Usd value={have} /> of <Usd value={usdFixed(need)} />
                  </span>
                </div>
                <Progress bps={bps} label={`${side} team minimum`} />
              </div>
            );
          })}
          {o.eligibility.eligible ? (
            <Badge tone="success">Eligible for matching</Badge>
          ) : (
            <div>
              <Badge tone="warn">Not eligible yet</Badge>
              <ul className="mt-2 list-disc pl-5 text-xs text-fg-muted">
                {o.eligibility.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Your position"
            subtitle="Who referred you and where you sit in the team are recorded separately. Only an administrator can correct a position."
          />
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

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader
            title="Matching bonus"
            subtitle={`A share of operator-funded earnings by your ${program.matching.tree === 'sponsor' ? 'referral line' : 'team line'}, down ${program.matching.levels.length} levels.${program.matching.min_rank ? ` Requires rank ${program.matching.min_rank}.` : ''}`}
          />
          <Table head={['Level', 'Rate']}>
            {program.matching.levels.map((l) => (
              <tr key={l.level}>
                <Td>Level {l.level}</Td>
                <Td>{pct(l.rate_bps)}</Td>
              </tr>
            ))}
          </Table>
          <p className="mt-3 text-xs text-fg-muted">
            Status: {program.matching.enabled ? <Badge tone="success">Paying</Badge> : <Badge tone="neutral">Information only</Badge>}
          </p>
        </Card>

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
        <CardHeader
          title={`Matching and rank rewards (${o.rewards.length})`}
          subtitle={`${sum('pending').length} pending review · ${sum('approved').length} approved · ${sum('posted').length} paid. Only paid rewards are in your available balance.`}
        />
        <Table head={['Recorded', 'Reward', 'From', 'Amount', 'Status', 'Paid']} empty={o.rewards.length ? null : <EmptyState title="No rewards yet" />}>
          {o.rewards.map((r) => (
            <tr key={r.id}>
              <Td className="text-fg-muted">{dateTime(r.created_at)}</Td>
              <Td>{r.kind === 'matching' ? `Matching, level ${r.level} (${pct(r.rate_bps ?? 0)})` : `Rank ${r.rank_code}`}</Td>
              <Td>{r.source_code ? <Mono>{r.source_code}</Mono> : '—'}</Td>
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
