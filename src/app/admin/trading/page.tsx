import { redirect } from 'next/navigation';
import { serverEnv } from '@/server/env';
import type { Metadata } from 'next';
import { webDb } from '@/server/db';
import { adminTrading } from '@/server/queries/admin';
import { Badge, Card, CardHeader, EmptyState, Mono, PageHeader, SimulatedBadge, Table, Td } from '@/components/ui/primitives';
import { Money } from '@/components/ui/money';
import { ActionButton } from '@/components/app/actions';
import { JsonBlock } from '@/components/admin/json';
import { dateTime, navpuDisplay } from '@/lib/format';
import { parseFixed } from '@/lib/money';

export const metadata: Metadata = { title: 'Trading & allocation' };

type Val = { id: string; period_key: string; valued_at: Date; status: string; failure_reason: string | null; gross_asset_value_base: string | null; nav_base: string | null; navpu: string | null; realized_pnl_period_base: string | null; unrealized_change_period_base: string | null; fees_accrued_period_base: string | null; positions: unknown; price_source: string | null; is_simulated: boolean; allocations: number };
type Trade = { id: string; venue: string; external_execution_id: string; symbol: string; side: string; quantity: string; price: string; fee: string; fee_asset: string; executed_at: Date; is_simulated: boolean };
type Batch = { id: string; venue: string; received: number; inserted: number; duplicates: number; rejected: number; errors: unknown; created_at: Date };

export default async function AdminTradingPage() {
  // Group mode has no investment pool.
  if (serverEnv().GROUP_MODE) redirect('/admin');
  const t = await adminTrading(webDb());
  const valuations = t.valuations as Val[];
  const trades = t.trades as Trade[];
  const batches = t.batches as Batch[];
  return (
    <>
      <PageHeader title="Trading & allocation" description="Imported executions, NAV strikes and allocation batches. Simulated-venue data is labelled." actions={<>
        <ActionButton url="/api/admin/jobs" body={{ job: 'trades' }}>Import trades</ActionButton>
        <ActionButton url="/api/admin/jobs" body={{ job: 'valuation' }}>Run valuation</ActionButton>
      </>} />
      <Card>
        <CardHeader title="Valuations (NAV strikes)" />
        <Table head={['Period', 'Status', 'GAV', 'NAV', 'NAV/unit', 'Realized Δ', 'Unrealized Δ', 'Fees', 'Allocations', 'Positions']} empty={valuations.length ? null : <EmptyState title="No valuations yet" />}>
          {valuations.map((v) => (
            <tr key={v.id}>
              <Td className="whitespace-nowrap"><div>{v.period_key}</div><div className="text-xs text-fg-subtle">{dateTime(v.valued_at)}</div></Td>
              <Td>{v.status === 'final' ? <Badge tone="success">final</Badge> : <Badge tone="danger" title={v.failure_reason ?? ''}>failed</Badge>} {v.is_simulated ? <SimulatedBadge /> : null}
                {v.failure_reason ? <p className="mt-1 text-xs text-loss">{v.failure_reason}</p> : null}</Td>
              <Td>{v.gross_asset_value_base ? <Money value={v.gross_asset_value_base} decimals={6} /> : '—'}</Td>
              <Td>{v.nav_base ? <Money value={v.nav_base} decimals={6} /> : '—'}</Td>
              <Td className="num">{v.navpu ? navpuDisplay(parseFixed(v.navpu), 6) : '—'}</Td>
              <Td>{v.realized_pnl_period_base ? <Money value={v.realized_pnl_period_base} decimals={6} signed colored /> : '—'}</Td>
              <Td>{v.unrealized_change_period_base ? <Money value={v.unrealized_change_period_base} decimals={6} signed colored /> : '—'}</Td>
              <Td>{v.fees_accrued_period_base ? <Money value={v.fees_accrued_period_base} decimals={6} maxFraction={6} /> : '—'}</Td>
              <Td className="num">{v.allocations}</Td>
              <Td><JsonBlock value={v.positions} /></Td>
            </tr>
          ))}
        </Table>
      </Card>
      <div className="mt-6 grid gap-6 xl:grid-cols-[2fr_1fr]">
        <Card>
          <CardHeader title="Imported executions" />
          <Table head={['Executed', 'Execution id', 'Pair', 'Side', 'Qty', 'Price', 'Fee']} empty={trades.length ? null : <EmptyState title="No executions imported" />}>
            {trades.map((x) => (
              <tr key={x.id}>
                <Td className="whitespace-nowrap text-fg-muted">{dateTime(x.executed_at)}</Td>
                <Td><Mono>{x.external_execution_id}</Mono></Td>
                <Td>{x.symbol} {x.is_simulated ? <SimulatedBadge /> : null}</Td>
                <Td className={x.side === 'buy' ? 'text-gain' : 'text-loss'}>{x.side}</Td>
                <Td className="num">{x.quantity.replace(/0+$/, '')}</Td>
                <Td className="num">{x.price.replace(/0+$/, '').replace(/\.$/, '')}</Td>
                <Td className="num text-fg-muted">{x.fee.replace(/0+$/, '').replace(/\.$/, '')} {x.fee_asset}</Td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card>
          <CardHeader title="Import batches" subtitle="Duplicates are detected by (venue, execution id)" />
          <Table head={['When', 'Recv', 'New', 'Dup', 'Rej']}>
            {batches.map((b) => (
              <tr key={b.id}><Td className="text-xs text-fg-muted">{dateTime(b.created_at)}</Td><Td className="num">{b.received}</Td><Td className="num">{b.inserted}</Td><Td className="num">{b.duplicates}</Td>
                <Td className={b.rejected ? 'num text-loss' : 'num'}>{b.rejected}</Td></tr>
            ))}
          </Table>
        </Card>
      </div>
    </>
  );
}
