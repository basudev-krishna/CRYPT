import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowDownLeft, ArrowDownToLine, ArrowLeftRight, ArrowUpFromLine, ArrowUpRight, Clock, LineChart, PiggyBank, Sparkles, TrendingUp, Wallet } from 'lucide-react';
import { pageUser } from '@/server/http/auth';
import { webDb } from '@/server/db';
import { getDashboard, getUserSeries, listActivity } from '@/server/queries/user';
import { Badge, ButtonLink, Card, CardHeader, EmptyState, Notice, SimulatedBadge } from '@/components/ui/primitives';
import { Bps, Money, fmt } from '@/components/ui/money';
import { EVENT_LABELS } from '@/components/ui/status';
import { Stat } from '@/components/app/stat';
import { AllocationDonut, ValueChart } from '@/components/charts/value-chart';
import { Reveal, Stagger, StaggerItem } from '@/components/ui/motion';
import { baseToChart, dateTime } from '@/lib/format';
import { serverEnv } from '@/server/env';
import { realFundsActive } from '@/server/phase-guard';
import { memberHolding, microToBase } from '@/server/offchain/holdings';
import { heldLabel } from '@/components/ui/offchain';

export const metadata: Metadata = { title: 'Overview' };

const QUICK_ACTIONS = [
  { href: '/deposit', label: 'Deposit', hint: 'Add test USDT', icon: ArrowDownToLine },
  { href: '/withdraw', label: 'Withdraw', hint: 'Send to your wallet', icon: ArrowUpFromLine },
  { href: '/portfolio', label: 'Invest', hint: 'Join the pool', icon: LineChart },
  { href: '/transactions', label: 'History', hint: 'Every ledger entry', icon: ArrowLeftRight },
];

function greeting(): string {
  const h = new Date().getUTCHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export default async function DashboardPage() {
  const user = await pageUser();
  const db = webDb();
  const [d, series, activity, offPlatform] = await Promise.all([
    getDashboard(db, user.id),
    getUserSeries(db, user.id, 90),
    listActivity(db, user.id, 8),
    memberHolding(db, user.id),
  ]);
  const dec = d.token?.decimals ?? 6;
  const sym = d.token?.symbol ?? 'USDT';
  // Money the administrator holds for them counts in their total, not in what they can withdraw.
  const held = offPlatform && offPlatform.balance > 0n ? microToBase(offPlatform.balance, dec) : 0n;
  const total = d.totalAccountValue + held;
  // Recent activity: ledger entries plus what the administrator recorded for them, newest first.
  const recent = [
    ...activity.map((a) => ({
      key: `l:${a.entryId}`,
      at: new Date(a.postedAt),
      label: EVENT_LABELS[a.eventType] ?? a.eventType,
      cash: a.cashDelta,
      pending: a.pendingDelta,
      reserved: a.reservedDelta,
    })),
    ...(offPlatform?.entries ?? []).map((e) => ({
      key: `h:${e.id}`,
      at: new Date(e.createdAt),
      label: heldLabel(e),
      cash: microToBase(e.amountMicro, dec),
      pending: 0n,
      reserved: 0n,
    })),
  ]
    .sort((x, y) => y.at.getTime() - x.at.getTime())
    .slice(0, 8);
  // Group mode: no investment pool, so only balances and activity are shown.
  const group = serverEnv().GROUP_MODE;
  // Testnet wording ("test USDT") would be false with real funds.
  const realFunds = realFundsActive();
  const quickActions = (group ? QUICK_ACTIONS.filter((q) => q.href !== '/portfolio') : QUICK_ACTIONS).map((q) =>
    q.href === '/deposit' && realFunds ? { ...q, hint: 'Add USDT (BEP20)' } : q,
  );
  const perfAvailable = d.performance.month.periods > 0 && !d.position?.latestValuationFailed;
  const name = d.profile?.displayName?.split(' ')[0];
  const slices = [
    { key: 'available', label: 'Available', amount: d.available },
    { key: 'invested', label: 'Invested (est.)', amount: d.investmentValue },
    { key: 'pending', label: 'Pending investment', amount: d.pendingSubscription },
    { key: 'reserved', label: 'Reserved for withdrawals', amount: d.reserved },
    { key: 'held', label: 'Recorded by the administrator', amount: held },
  ].map((s) => ({ key: s.key, label: s.label, value: baseToChart(s.amount, dec), display: `${fmt(s.amount, dec)} ${sym}` }));

  return (
    <>
      <Reveal>
        <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="flex items-center gap-1.5 text-sm text-fg-muted">
              <Sparkles size={14} className="text-accent" aria-hidden /> {greeting()}
              {name ? `, ${name}` : ''}
            </p>
            <h1 className="mt-1 font-heading text-[clamp(1.7rem,3.2vw,2.4rem)] leading-tight">Your account</h1>
          </div>
          <div className="flex gap-2">
            <ButtonLink href="/deposit">
              <ArrowDownToLine size={16} aria-hidden /> Deposit
            </ButtonLink>
            <ButtonLink href="/withdraw" variant="secondary">
              <ArrowUpFromLine size={16} aria-hidden /> Withdraw
            </ButtonLink>
          </div>
        </header>
      </Reveal>

      {d.profile && d.profile.accountStatus !== 'active' ? (
        <div className="mb-6">
          <Notice tone="danger" title={`Account ${d.profile.accountStatus}`}>
            {d.profile.restrictionReason ?? 'Some actions are unavailable. Contact support for details.'}
          </Notice>
        </div>
      ) : null}


      <Stagger className={`grid gap-4 sm:grid-cols-2 ${group ? '' : 'xl:grid-cols-4'}`}>
        <StaggerItem>
          <Stat emphasis icon={Wallet} label="Total account value" value={<Money value={total} decimals={dec} symbol={sym} className="[&>span]:text-white/70" />} badge={d.isSimulated ? <SimulatedBadge /> : null} sub={`${group ? 'Available + reserved for withdrawals' : 'Available + reserved + pending + investments'}`} />
        </StaggerItem>
        <StaggerItem>
          <Stat icon={PiggyBank} label="Available to withdraw" value={<Money value={d.available} decimals={dec} symbol={sym} />} sub={<>Reserved: <Money value={d.reserved} decimals={dec} /></>} />
        </StaggerItem>
        {group ? null : (
          <>
        <StaggerItem>
          <Stat
            icon={TrendingUp}
            label="Investment value"
            value={d.position?.value !== null && d.position?.value !== undefined ? <Money value={d.investmentValue} decimals={dec} symbol={sym} /> : <span className="text-fg-subtle">—</span>}
            badge={<Badge tone="info">Est. · NAV</Badge>}
            sub={d.position?.navAsOf ? `NAV as of ${dateTime(d.position.navAsOf)}` : 'No NAV struck yet'}
          />
        </StaggerItem>
        <StaggerItem>
          <Stat icon={Clock} label="Profit & loss" value={<Money value={d.unrealized + d.realized} decimals={dec} signed colored />} sub={<>Realized <Money value={d.realized} decimals={dec} signed /> · unrealized <Money value={d.unrealized} decimals={dec} signed /></>} />
        </StaggerItem>
          </>
        )}
      </Stagger>

      <Stagger className={`mt-4 grid grid-cols-2 gap-3 ${group ? 'lg:grid-cols-3' : 'lg:grid-cols-4'}`}>
        {quickActions.map(({ href, label, hint, icon: Icon }) => (
          <StaggerItem key={href}>
            <Link href={href} className="group flex items-center gap-3 rounded-2xl bg-white/70 p-3.5 ring-1 ring-black/5 transition hover:-translate-y-0.5 hover:shadow-lg hover:ring-accent/30">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent transition group-hover:bg-accent group-hover:text-white">
                <Icon size={18} aria-hidden />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium">{label}</span>
                <span className="block truncate text-xs text-fg-muted">{hint}</span>
              </span>
              <ArrowUpRight size={16} aria-hidden className="ml-auto text-fg-subtle transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-accent" />
            </Link>
          </StaggerItem>
        ))}
      </Stagger>

      {group ? null : (
      <div className="mt-6 grid gap-6 xl:grid-cols-[1.7fr_1fr]">
        <Reveal>
          <Card className="h-full">
            <CardHeader title="Investment value" subtitle="Value of your units at each NAV strike. Hover the line for exact figures." action={d.isSimulated ? <SimulatedBadge /> : null} />
            {series.length > 1 ? (
              <ValueChart withRanges label={`Value (${sym})`} simulated={d.isSimulated} data={series.map((p) => ({ t: new Date(p.at).toISOString(), v: baseToChart(p.value, dec) }))} />
            ) : (
              <EmptyState title="Your chart starts after your first investment" action={<ButtonLink href="/portfolio" variant="secondary">Explore the pool</ButtonLink>}>
                Results appear once your funds are invested and at least two NAV strikes have run.
              </EmptyState>
            )}
          </Card>
        </Reveal>
        <Reveal delay={0.08}>
          <Card className="h-full">
            <CardHeader title="Where your money is" subtitle="Hover a slice or row to see its share" />
            <AllocationDonut slices={slices} centerLabel="Total" centerValue={`${fmt(total, dec)} ${sym}`} />
          </Card>
        </Reveal>
      </div>
      )}

      <div className="mt-6 grid gap-6 xl:grid-cols-[1.7fr_1fr]">
        <Reveal>
          <Card className="h-full">
            <CardHeader title="Recent activity" action={<Link href="/transactions" className="text-xs font-medium text-accent hover:underline">All transactions →</Link>} />
            {recent.length ? (
              <ol className="relative space-y-1 before:absolute before:bottom-3 before:left-[19px] before:top-3 before:w-px before:bg-line">
                {recent.map((a) => {
                  const incoming = a.cash > 0n;
                  const outgoing = a.cash < 0n;
                  const Icon = incoming ? ArrowDownLeft : outgoing ? ArrowUpRight : ArrowLeftRight;
                  return (
                    <li key={a.key} className="relative flex items-center gap-3 rounded-xl px-1 py-2 transition-colors hover:bg-surface-3/60">
                      <span className={`relative grid h-10 w-10 shrink-0 place-items-center rounded-full ring-4 ring-white ${incoming ? 'bg-gain/10 text-gain' : outgoing ? 'bg-loss/10 text-loss' : 'bg-accent/10 text-accent'}`}>
                        <Icon size={16} aria-hidden />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{a.label}</p>
                        <p className="text-xs text-fg-subtle">{dateTime(a.at)}</p>
                      </div>
                      <div className="text-right text-xs">
                        {a.cash !== 0n ? <div className="text-sm"><Money value={a.cash} decimals={dec} signed colored /></div> : null}
                        {a.pending !== 0n ? <div className="text-fg-muted">Pending <Money value={a.pending} decimals={dec} signed /></div> : null}
                        {a.reserved !== 0n ? <div className="text-fg-muted">Reserved <Money value={a.reserved} decimals={dec} signed /></div> : null}
                      </div>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <EmptyState title="No activity yet" action={<ButtonLink href="/deposit">Make your first deposit</ButtonLink>}>
                Deposits, investments and withdrawals will appear here as they happen.
              </EmptyState>
            )}
          </Card>
        </Reveal>
        <Reveal delay={0.08}>
          <Card className="h-full">
            {group ? (
              <CardHeader title="Account" />
            ) : (
              <>
            <CardHeader title="Performance" subtitle="Your share of actual pool results" action={d.isSimulated ? <SimulatedBadge /> : null} />
            {perfAvailable ? (
              <dl className="space-y-2">
                {([['24 hours', d.performance.day], ['7 days', d.performance.week], ['30 days', d.performance.month]] as const).map(([label, w]) => (
                  <div key={label} className="flex items-center justify-between gap-4 rounded-xl px-3 py-2.5 transition-colors hover:bg-surface-3/60" title={`Realized ${fmt(w.realized, dec)} · unrealized ${fmt(w.unrealized, dec)} · fees ${fmt(w.fees, dec)}`}>
                    <dt className="text-sm text-fg-muted">{label}</dt>
                    <dd>
                      <Money value={w.pnl} decimals={dec} signed colored className="text-base font-semibold" />
                    </dd>
                  </div>
                ))}
                <div className="mt-2 flex justify-between border-t border-line px-3 pt-3 text-sm">
                  <dt className="text-fg-muted">Pool return, 24h</dt>
                  <dd>
                    <Bps value={d.dailyReturnBps} />
                  </dd>
                </div>
              </dl>
            ) : (
              <EmptyState title="Performance unavailable">
                {d.position?.latestValuationFailed ? 'The latest valuation could not be completed. Figures update after the next successful valuation.' : 'No verified trading results have been allocated to your account yet.'}
              </EmptyState>
            )}
              </>
            )}
            <div className="mt-5 space-y-2 border-t border-line pt-4 text-sm">
              <div className="flex justify-between"><span className="text-fg-muted">Pending deposits</span><span className="num">{d.pending.depositsCount}</span></div>
              <div className="flex justify-between"><span className="text-fg-muted">Pending withdrawals</span><span className="num">{d.pending.withdrawalsCount}</span></div>
            </div>
          </Card>
        </Reveal>
      </div>
    </>
  );
}
