import type { Metadata } from 'next';
import Link from 'next/link';
import { pageUser } from '@/server/http/auth';
import { webDb } from '@/server/db';
import { getDashboard, getUserSeries, listActivity } from '@/server/queries/user';
import { Badge, ButtonLink, Card, CardHeader, EmptyState, Notice, PageHeader, SimulatedBadge } from '@/components/ui/primitives';
import { Bps, Money } from '@/components/ui/money';
import { EVENT_LABELS, KycStatus } from '@/components/ui/status';
import { Stat } from '@/components/app/stat';
import { ValueChart } from '@/components/charts/value-chart';
import { baseToChart, dateTime } from '@/lib/format';
import { RISK_DISCLOSURE_VERSION } from '@/lib/disclosures';

export const metadata: Metadata = { title: 'Overview' };

export default async function DashboardPage() {
  const user = await pageUser();
  const db = webDb();
  const [d, series, activity] = await Promise.all([getDashboard(db, user.id), getUserSeries(db, user.id, 90), listActivity(db, user.id, 8)]);
  const dec = d.token?.decimals ?? 6;
  const sym = d.token?.symbol ?? 'USDT';
  const perfAvailable = d.performance.month.periods > 0 && !d.position?.latestValuationFailed;
  const onboarding = [
    { done: true, label: 'Email verified' },
    { done: d.profile?.kycStatus === 'approved', label: 'Identity verification', href: '/settings' },
    { done: d.profile?.riskDisclosureVersion === RISK_DISCLOSURE_VERSION, label: 'Risk disclosure accepted', href: '/disclosures' },
    { done: user.hasMfaFactor, label: 'Two-factor authentication', href: '/settings/security' },
  ];

  return (
    <>
      <PageHeader
        title="Overview"
        description="All figures are derived from the platform ledger. Investment results come only from imported trade executions."
        actions={
          <>
            <ButtonLink href="/deposit">Deposit</ButtonLink>
            <ButtonLink href="/withdraw" variant="secondary">
              Withdraw
            </ButtonLink>
          </>
        }
      />

      {d.profile && d.profile.accountStatus !== 'active' ? (
        <div className="mb-6">
          <Notice tone="danger" title={`Account ${d.profile.accountStatus}`}>
            {d.profile.restrictionReason ?? 'Some actions are unavailable. Contact support for details.'}
          </Notice>
        </div>
      ) : null}

      {onboarding.some((o) => !o.done) ? (
        <Card className="mb-6">
          <CardHeader title="Finish setting up" subtitle="Deposits and withdrawals unlock once these steps are complete." />
          <ul className="grid gap-2 sm:grid-cols-4">
            {onboarding.map((o) => (
              <li key={o.label} className="flex items-center gap-2 text-sm">
                <span aria-hidden className={o.done ? 'text-gain' : 'text-fg-subtle'}>{o.done ? '●' : '○'}</span>
                {o.done || !o.href ? <span className={o.done ? 'text-fg-muted' : ''}>{o.label}</span> : <Link href={o.href} className="text-accent hover:underline">{o.label}</Link>}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat emphasis label="Total account value" value={<Money value={d.totalAccountValue} decimals={dec} symbol={sym} />} badge={d.isSimulated ? <SimulatedBadge /> : null}
          sub="Available + reserved + pending + investment value" />
        <Stat label="Available to withdraw" value={<Money value={d.available} decimals={dec} symbol={sym} />} sub={<>Reserved: <Money value={d.reserved} decimals={dec} /></>} />
        <Stat
          label="Investment value"
          value={d.position?.value !== null && d.position?.value !== undefined ? <Money value={d.investmentValue} decimals={dec} symbol={sym} /> : <span className="text-fg-subtle">—</span>}
          badge={<Badge tone="info">Estimated · NAV</Badge>}
          sub={d.position?.navAsOf ? `NAV as of ${dateTime(d.position.navAsOf)}` : 'No NAV struck yet'}
        />
        <Stat label="Deposited principal" value={<Money value={d.principal} decimals={dec} symbol={sym} />} sub={<>Pending investment: <Money value={d.pendingSubscription} decimals={dec} /></>} />
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Unrealized P&L" value={<Money value={d.unrealized} decimals={dec} signed colored />} sub="Position value − cost basis" badge={<Badge tone="info">Estimated</Badge>} />
        <Stat label="Realized P&L" value={<Money value={d.realized} decimals={dec} signed colored />} sub="Locked in by redemptions" />
        <Stat label="Pending deposits" value={<span className="num">{d.pending.depositsCount}</span>} sub={<><Money value={d.pending.depositsAmount} decimals={dec} symbol={sym} /> awaiting confirmation/review</>} />
        <Stat label="Pending withdrawals" value={<span className="num">{d.pending.withdrawalsCount}</span>} sub={<><Money value={d.pending.withdrawalsAmount} decimals={dec} symbol={sym} /> in progress</>} />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[2fr_1fr]">
        <Card>
          <CardHeader title="Investment value" subtitle="Value of your units at each NAV strike" action={d.isSimulated ? <SimulatedBadge /> : null} />
          {series.length > 1 ? (
            <ValueChart label={`Value (${sym})`} simulated={d.isSimulated} data={series.map((p) => ({ t: new Date(p.at).toISOString(), v: baseToChart(p.value, dec) }))} />
          ) : (
            <EmptyState title="Performance unavailable">No allocated investment results yet. Results appear after your funds have been invested and at least two NAV strikes.</EmptyState>
          )}
        </Card>
        <Card>
          <CardHeader title="Performance" subtitle="Your allocated share of actual pool results" action={d.isSimulated ? <SimulatedBadge /> : null} />
          {perfAvailable ? (
            <dl className="space-y-4 text-sm">
              {([['Last 24 hours', d.performance.day], ['Last 7 days', d.performance.week], ['Last 30 days', d.performance.month]] as const).map(([label, w]) => (
                <div key={label} className="flex items-start justify-between gap-4">
                  <dt className="text-fg-muted">{label}</dt>
                  <dd className="text-right">
                    <Money value={w.pnl} decimals={dec} signed colored className="text-base font-medium" />
                    <div className="text-xs text-fg-subtle">
                      realized <Money value={w.realized} decimals={dec} signed /> · unrealized <Money value={w.unrealized} decimals={dec} signed /> · fees <Money value={w.fees} decimals={dec} />
                    </div>
                  </dd>
                </div>
              ))}
              <div className="flex justify-between border-t border-line pt-3">
                <dt className="text-fg-muted">Pool return, 24h (NAV/unit)</dt>
                <dd><Bps value={d.dailyReturnBps} /></dd>
              </div>
            </dl>
          ) : (
            <EmptyState title="Performance unavailable">
              {d.position?.latestValuationFailed ? 'The latest valuation could not be completed (e.g. price feed unavailable). Figures will update after the next successful valuation.' : 'No verified trading results have been allocated to your account yet.'}
            </EmptyState>
          )}
        </Card>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[2fr_1fr]">
        <Card>
          <CardHeader title="Recent activity" action={<Link href="/transactions" className="text-xs text-accent hover:underline">All transactions →</Link>} />
          {activity.length ? (
            <ol className="space-y-3">
              {activity.map((a) => (
                <li key={a.entryId} className="flex items-center justify-between gap-4 text-sm">
                  <div>
                    <p>{EVENT_LABELS[a.eventType] ?? a.eventType}</p>
                    <p className="text-xs text-fg-subtle">{dateTime(a.postedAt)}</p>
                  </div>
                  <div className="text-right text-xs">
                    {a.cashDelta !== 0n ? <div>Available <Money value={a.cashDelta} decimals={dec} signed colored /></div> : null}
                    {a.pendingDelta !== 0n ? <div>Pending <Money value={a.pendingDelta} decimals={dec} signed /></div> : null}
                    {a.reservedDelta !== 0n ? <div>Reserved <Money value={a.reservedDelta} decimals={dec} signed /></div> : null}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <EmptyState title="No activity yet" action={<ButtonLink href="/deposit">Make a deposit</ButtonLink>} />
          )}
        </Card>
        <Card>
          <CardHeader title="Account" />
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between"><dt className="text-fg-muted">Verification</dt><dd><KycStatus status={d.profile?.kycStatus ?? 'not_started'} /></dd></div>
            <div className="flex justify-between"><dt className="text-fg-muted">Two-factor</dt><dd>{user.hasMfaFactor ? <Badge tone="success">Enabled</Badge> : <Badge tone="warn">Off</Badge>}</dd></div>
            <div className="flex justify-between"><dt className="text-fg-muted">Account status</dt><dd className="capitalize">{d.profile?.accountStatus}</dd></div>
          </dl>
          <div className="mt-5 grid grid-cols-2 gap-2 text-sm">
            <Link className="rounded-md border border-line px-3 py-2 text-center hover:border-accent/60" href="/portfolio">Investments</Link>
            <Link className="rounded-md border border-line px-3 py-2 text-center hover:border-accent/60" href="/settings">Settings</Link>
            <Link className="rounded-md border border-line px-3 py-2 text-center hover:border-accent/60" href="/disclosures">Risk disclosure</Link>
            <Link className="rounded-md border border-line px-3 py-2 text-center hover:border-accent/60" href="/support">Support</Link>
          </div>
        </Card>
      </div>
    </>
  );
}
