import type { Metadata } from 'next';
import { webDb } from '@/server/db';
import { adminReconciliationRuns, adminTreasury } from '@/server/queries/admin';
import { Badge, ButtonLink, Card, CardHeader, EmptyState, Mono, PageHeader, Table, Td, shortHash } from '@/components/ui/primitives';
import { Money } from '@/components/ui/money';
import { ActionButton } from '@/components/app/actions';
import { JsonBlock } from '@/components/admin/json';
import { dateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Treasury & reconciliation' };

type Snap = { network: string; symbol: string; decimals: number; onchain_balance_base: string | null; ledger_treasury_base: string; virtual_venue_net_base: string; in_flight_out_base: string; customer_liabilities_base: string; pool_assets_base: string; discrepancy_base: string | null; wallets: unknown };
type Check = { name: string; scope: string; status: string; blocking: boolean; detail: unknown };

export default async function AdminTreasuryPage() {
  const db = webDb();
  const [t, runs] = await Promise.all([adminTreasury(db), adminReconciliationRuns(db)]);
  const snaps = t.snapshots as Snap[];
  return (
    <>
      <PageHeader title="Treasury & reconciliation" description="On-chain balances vs ledger assets, assets vs customer liabilities, pending transfers and reserve thresholds."
        actions={<><ActionButton url="/api/admin/jobs" body={{ job: 'reconciliation' }}>Run reconciliation</ActionButton><ButtonLink variant="secondary" href="/api/admin/reconciliation/export">Export CSV</ButtonLink></>} />
      <Card>
        <CardHeader title="Latest snapshot" />
        <Table head={['Network', 'On-chain', 'Ledger treasury', 'Virtual venue net', 'In-flight out', 'Pool assets', 'Customer liabilities', 'Discrepancy']} empty={snaps.length ? null : <EmptyState title="No reconciliation run yet" />}>
          {snaps.map((s) => (
            <tr key={s.network}>
              <Td>{s.network} · {s.symbol}</Td>
              <Td>{s.onchain_balance_base !== null ? <Money value={s.onchain_balance_base} decimals={s.decimals} /> : <Badge tone="danger">unavailable</Badge>}</Td>
              <Td><Money value={s.ledger_treasury_base} decimals={s.decimals} /></Td>
              <Td><Money value={s.virtual_venue_net_base} decimals={s.decimals} signed /></Td>
              <Td><Money value={s.in_flight_out_base} decimals={s.decimals} /></Td>
              <Td><Money value={s.pool_assets_base} decimals={s.decimals} /></Td>
              <Td><Money value={s.customer_liabilities_base} decimals={s.decimals} /></Td>
              <Td>{s.discrepancy_base === null ? '—' : s.discrepancy_base === '0' ? <Badge tone="success">0</Badge> : <Money value={s.discrepancy_base} decimals={s.decimals} signed colored />}</Td>
            </tr>
          ))}
        </Table>
      </Card>
      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title="Reconciliation runs" />
          <Table head={['Started', 'Status', 'Trigger', 'Auto-paused', 'Checks']}>
            {runs.map((r) => (
              <tr key={r.id}>
                <Td className="whitespace-nowrap text-fg-muted">{dateTime(r.started_at)}</Td>
                <Td><Badge tone={r.status === 'ok' ? 'success' : r.status === 'running' ? 'info' : 'danger'}>{r.status}</Badge></Td>
                <Td className="text-xs text-fg-muted">{r.triggered_by}</Td>
                <Td>{r.auto_paused ? <Badge tone="danger">yes</Badge> : 'no'}</Td>
                <Td>
                  <ul className="space-y-0.5 text-xs">
                    {(r.checks as Check[]).map((c, i) => (
                      <li key={i} className={c.status === 'fail' ? 'text-loss' : c.status === 'warn' ? 'text-warn' : 'text-fg-muted'}>{c.status} · {c.name} ({c.scope})</li>
                    ))}
                  </ul>
                  <JsonBlock value={r.checks} />
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card>
          <CardHeader title="Wallets" subtitle="Addresses controlled through the custody provider. No keys are stored by the application." />
          <Table head={['Network', 'Kind', 'Address', 'Custody']}>
            {(t.wallets as { id: number; network: string; kind: string; address: string; custody_provider: string }[]).map((w) => (
              <tr key={w.id}><Td>{w.network}</Td><Td>{w.kind}</Td><Td><Mono>{shortHash(w.address, 6)}</Mono></Td><Td className="text-xs">{w.custody_provider}</Td></tr>
            ))}
          </Table>
          <CardHeader title="Treasury movements" />
          <Table head={['When', 'Kind', 'Amount', 'Status', 'Tx']}>
            {(t.transfers as { id: string; kind: string; amount_base: string; status: string; is_virtual: boolean; tx_hash: string | null; created_at: Date }[]).map((x) => (
              <tr key={x.id}><Td className="text-xs text-fg-muted">{dateTime(x.created_at)}</Td><Td>{x.kind}{x.is_virtual ? <span className="ml-1 text-xs text-sim">virtual</span> : null}</Td>
                <Td><Money value={x.amount_base} decimals={6} /></Td><Td>{x.status}</Td><Td><Mono>{shortHash(x.tx_hash, 4)}</Mono></Td></tr>
            ))}
          </Table>
        </Card>
      </div>
    </>
  );
}
