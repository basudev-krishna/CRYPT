import type { Metadata } from 'next';
import Link from 'next/link';
import { webDb } from '@/server/db';
import { adminWithdrawals } from '@/server/queries/admin';
import { Badge, Card, CardHeader, EmptyState, Mono, PageHeader, SimulatedBadge, Table, Td, shortHash } from '@/components/ui/primitives';
import { Money } from '@/components/ui/money';
import { WithdrawalStatus } from '@/components/ui/status';
import { NoteAction } from '@/components/app/actions';
import { JsonBlock } from '@/components/admin/json';
import { ManualPayoutForm } from '@/components/admin/group-forms';
import { listManualPayoutTasks } from '@/server/withdrawals/manual-payouts';
import { dateTime } from '@/lib/format';
import { formatUnits } from '@/lib/money';

export const metadata: Metadata = { title: 'Withdrawals' };
const FILTERS = ['reserved', 'processing', 'broadcast', 'confirmed', 'failed', 'rejected'];

export default async function AdminWithdrawalsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  const [rows, payouts] = await Promise.all([adminWithdrawals(webDb(), status && FILTERS.includes(status) ? status : null), listManualPayoutTasks(webDb())]);
  return (
    <>
      <PageHeader title="Withdrawals" description="Pending payouts, risk-check results, custody signing/broadcast status, reviews and compliance holds." />
      {payouts.length ? (
        <Card className="mb-6">
          <CardHeader
            title={`Payouts to send (${payouts.length})`}
            subtitle="Send exactly the net amount from the group wallet with your own wallet. Once the transaction is mined, paste its hash: it is checked on chain before it is accepted."
          />
          <Table head={['Requested', 'Member', 'Send exactly', 'To address', 'Network', 'Record']}>
            {payouts.map((p) => (
              <tr key={p.withdrawalId}>
                <Td className="whitespace-nowrap text-fg-muted">{dateTime(p.requestedAt)}</Td>
                <Td className="text-xs"><Link className="text-accent hover:underline" href={`/admin/users/${p.userId}`}>{p.email}</Link></Td>
                <Td className="num whitespace-nowrap">{formatUnits(p.netAmount, p.decimals)} {p.symbol}</Td>
                <Td><code className="break-all font-mono text-xs">{p.destination}</code></Td>
                <Td className="text-xs">{p.network}</Td>
                <Td className="w-80"><ManualPayoutForm withdrawalId={p.withdrawalId} /></Td>
              </tr>
            ))}
          </Table>
        </Card>
      ) : null}
      <div className="mb-3 flex flex-wrap gap-2 text-xs">
        <Link href="/admin/withdrawals" className="rounded-full border border-line px-3 py-1 hover:border-accent">All</Link>
        {FILTERS.map((f) => <Link key={f} href={`/admin/withdrawals?status=${f}`} className={`rounded-full border px-3 py-1 hover:border-accent ${status === f ? 'border-accent text-fg' : 'border-line text-fg-muted'}`}>{f}</Link>)}
      </div>
      <Card>
        <Table head={['Requested', 'User', 'Amount', 'Destination', 'Status', 'Tx (attempts)', 'Checks', 'Actions']} empty={rows.length ? null : <EmptyState title="No withdrawals" />}>
          {rows.map((w) => (
            <tr key={w.id}>
              <Td className="whitespace-nowrap text-fg-muted">{dateTime(w.created_at)}</Td>
              <Td className="text-xs"><Link className="text-accent hover:underline" href={`/admin/users/${w.user_id}`}>{w.email}</Link></Td>
              <Td><Money value={w.amount_base} decimals={6} /><p className="text-xs text-fg-subtle">fee <Money value={w.fee_base} decimals={6} /></p></Td>
              <Td><Mono>{shortHash(w.destination_address, 6)}</Mono></Td>
              <Td>
                <WithdrawalStatus status={w.status} /> {w.is_simulated ? <SimulatedBadge /> : null}
                {w.requires_manual_review && !w.reviewed_by && w.status === 'reserved' ? <div className="mt-1"><Badge tone="warn">needs review</Badge></div> : null}
                {w.compliance_hold ? <div className="mt-1"><Badge tone="danger">compliance hold</Badge></div> : null}
                {w.status_reason ? <p className="mt-1 text-xs text-fg-subtle">{w.status_reason}</p> : null}
              </Td>
              <Td><Mono>{shortHash(w.tx_hash)}</Mono> <span className="text-xs text-fg-subtle">({w.attempts})</span></Td>
              <Td>{w.risk_result ? <JsonBlock value={w.risk_result} /> : null}</Td>
              <Td className="w-72 space-y-3">
                {w.status === 'reserved' && w.requires_manual_review && !w.reviewed_by ? (
                  <NoteAction url={`/api/admin/withdrawals/${w.id}/review`} options={[{ value: 'approve', label: 'Approve payout', field: 'decision' }, { value: 'reject', label: 'Reject and release', field: 'decision' }]} noteLabel="Review note" />
                ) : null}
                {['pending_verification', 'reserved'].includes(w.status) ? (
                  <NoteAction url={`/api/admin/withdrawals/${w.id}/hold`} options={[{ value: w.compliance_hold ? 'false' : 'true', label: w.compliance_hold ? 'Release hold' : 'Place compliance hold', field: 'hold' }]} submitLabel={w.compliance_hold ? 'Release' : 'Hold'} noteLabel="Hold note" />
                ) : null}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
