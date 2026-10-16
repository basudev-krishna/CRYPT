import type { Metadata } from 'next';
import { pageUser } from '@/server/http/auth';
import { webDb } from '@/server/db';
import { getDashboard, getUserSeries, listAllocations, listOrders } from '@/server/queries/user';
import { Badge, Card, CardHeader, EmptyState, Notice, PageHeader, SimulatedBadge, Table, Td } from '@/components/ui/primitives';
import { Bps, Money } from '@/components/ui/money';
import { OrderStatus } from '@/components/ui/status';
import { Stat } from '@/components/app/stat';
import { PnlBars, ValueChart } from '@/components/charts/value-chart';
import { InvestForm, RedeemForm, ActionButton } from '@/components/app/actions';
import { baseToChart, dateTime, navpuDisplay, unitsDisplay } from '@/lib/format';
import { fmt } from '@/components/ui/money';

export const metadata: Metadata = { title: 'Portfolio & performance' };

export default async function PortfolioPage() {
  const user = await pageUser();
  const db = webDb();
  const [d, series, allocations, orders] = await Promise.all([getDashboard(db, user.id), getUserSeries(db, user.id, 180), listAllocations(db, user.id), listOrders(db, user.id)]);
  const dec = d.token?.decimals ?? 6;
  const sym = d.token?.symbol ?? 'USDT';
  const pos = d.position;
  const pool = await db.query<{ id: number; name: string; is_simulated: boolean; venue: string }>("select id, name, is_simulated, venue from public.investment_pools where status = 'active' order by id limit 1");
  const p = pool.rows[0];

  return (
    <>
      <PageHeader title="Portfolio & performance" description="Your units in the investment pool, valued at the latest NAV per unit. Gains and losses are allocated from actual (here: simulated-venue) trade executions." />
      {p?.is_simulated ? (
        <div className="mb-6">
          <Notice tone="sim" title="Simulated trading venue">
            Performance on this page comes from a development trading simulator ({p.venue}). It demonstrates the accounting engine and is <strong>not</strong> actual investment performance.
          </Notice>
        </div>
      ) : null}
      {pos?.latestValuationFailed ? (
        <div className="mb-6"><Notice tone="warn" title="Latest valuation failed">The most recent NAV strike could not be completed. Values shown are from the last successful valuation.</Notice></div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat emphasis label="Investment value" value={pos?.value != null ? <Money value={pos.value} decimals={dec} symbol={sym} /> : '—'} badge={p?.is_simulated ? <SimulatedBadge /> : <Badge tone="info">Estimated</Badge>}
          sub={pos?.navAsOf ? `as of ${dateTime(pos.navAsOf)}` : 'No NAV yet'} />
        <Stat label="Units held" value={<span className="num">{pos ? unitsDisplay(pos.units) : '0.0000'}</span>} sub={pos && pos.unitsLocked > 0n ? `${unitsDisplay(pos.unitsLocked)} pending redemption` : 'Pool units'} />
        <Stat label="NAV per unit" value={<span className="num">{pos?.navpu ? navpuDisplay(pos.navpu, dec) : '—'}</span>} sub={<>24h: <Bps value={d.dailyReturnBps} /></>} />
        <Stat label="Cost basis" value={<Money value={pos?.costBasis ?? 0n} decimals={dec} symbol={sym} />} sub={<>Unrealized <Money value={d.unrealized} decimals={dec} signed colored /> · Realized <Money value={d.realized} decimals={dec} signed colored /></>} />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title="Value history" action={p?.is_simulated ? <SimulatedBadge /> : null} />
          {series.length > 1 ? <ValueChart label={`Value (${sym})`} simulated={Boolean(p?.is_simulated)} data={series.map((s) => ({ t: new Date(s.at).toISOString(), v: baseToChart(s.value, dec) }))} />
            : <EmptyState title="Performance unavailable">Not enough valuation history yet.</EmptyState>}
        </Card>
        <Card>
          <CardHeader title="Profit / loss per period" subtitle="Losses are shown, never hidden" />
          {series.length ? <PnlBars data={series.map((s) => ({ t: new Date(s.at).toISOString(), v: baseToChart(s.pnl, dec) }))} />
            : <EmptyState title="Performance unavailable" />}
        </Card>
      </div>

      {p ? (
        <Card className="mt-6">
          <CardHeader title="Invest or redeem" subtitle="Orders execute at the next NAV strike (forward pricing), so new money never receives gains earned before it joined." />
          <div className="grid gap-6 lg:grid-cols-2">
            <InvestForm poolId={Number(p.id)} symbol={sym} availableDisplay={`${fmt(d.available, dec)} ${sym}`} />
            {pos && pos.units > pos.unitsLocked ? <RedeemForm poolId={Number(p.id)} freeUnits={unitsDisplay(pos.units - pos.unitsLocked)} /> : <p className="text-sm text-fg-muted">No redeemable units.</p>}
          </div>
        </Card>
      ) : null}

      <Card className="mt-6">
        <CardHeader title="Allocated results" subtitle="Your share of each period: realized and unrealized components are pro-rata; fees are deducted in NAV." />
        <Table head={['Period', 'P&L', 'Realized share', 'Unrealized share', 'Fees share', '']} empty={allocations.length ? null : <EmptyState title="No allocations yet" />}>
          {allocations.map((a) => (
            <tr key={a.periodKey + a.at.toString()}>
              <Td className="whitespace-nowrap text-fg-muted">{dateTime(a.at)}</Td>
              <Td><Money value={a.pnl} decimals={dec} signed colored maxFraction={4} /></Td>
              <Td><Money value={a.realized} decimals={dec} signed maxFraction={4} /></Td>
              <Td><Money value={a.unrealized} decimals={dec} signed maxFraction={4} /></Td>
              <Td><Money value={a.fees} decimals={dec} maxFraction={4} /></Td>
              <Td>{a.isSimulated ? <SimulatedBadge /> : null}</Td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card className="mt-6">
        <CardHeader title="Investment orders" />
        <Table head={['Requested', 'Type', 'Amount', 'Units', 'NAV/unit', 'Realized', 'Status', '']} empty={orders.length ? null : <EmptyState title="No orders yet" />}>
          {orders.map((o) => (
            <tr key={o.id}>
              <Td className="whitespace-nowrap text-fg-muted">{dateTime(o.requested_at)}</Td>
              <Td className="capitalize">{o.kind}</Td>
              <Td>{o.amount !== null ? <Money value={o.amount} decimals={dec} /> : '—'}</Td>
              <Td className="num">{o.unitsFixed !== null ? unitsDisplay(o.unitsFixed) : '—'}</Td>
              <Td className="num">{o.navpuFixed !== null ? navpuDisplay(o.navpuFixed, dec) : '—'}</Td>
              <Td>{o.realized !== null ? <Money value={o.realized} decimals={dec} signed colored /> : '—'}</Td>
              <Td><OrderStatus status={o.status} /></Td>
              <Td>{o.status === 'pending' ? <ActionButton url={`/api/investments/orders/${o.id}/cancel`} variant="ghost" confirmText="Cancel this order?">Cancel</ActionButton> : null}</Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
