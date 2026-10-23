import type { Metadata } from 'next';
import Link from 'next/link';
import { webDb } from '@/server/db';
import { adminActiveMembers, adminDeposits } from '@/server/queries/admin';
import { listNetworks } from '@/server/chains/registry';
import { Card, CardHeader, EmptyState, Mono, PageHeader, SimulatedBadge, Table, Td, shortHash } from '@/components/ui/primitives';
import { Money } from '@/components/ui/money';
import { DepositStatus } from '@/components/ui/status';
import { NoteAction } from '@/components/app/actions';
import { InvestigateForm } from '@/components/admin/investigate-form';
import { AllocationForm } from '@/components/admin/group-forms';
import { JsonBlock } from '@/components/admin/json';
import { dateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Deposits' };
const FILTERS = ['under_review', 'recovery_required', 'confirming', 'credited', 'failed'];

export default async function AdminDepositsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  const db = webDb();
  const [rows, networks, activeMembers] = await Promise.all([adminDeposits(db, status && FILTERS.includes(status) ? status : null), listNetworks(db), adminActiveMembers(db)]);
  const members = activeMembers.map((m) => ({ userId: m.user_id, label: `${m.member_code} · ${m.display_name ?? m.username ?? m.email ?? ''}` }));
  return (
    <>
      <PageHeader title="Deposits" description="Monitor incoming transfers, assign or distribute unattributed group-wallet receipts, reverse wrong credits, and investigate missing transfers." />
      <Card className="mb-6">
        <CardHeader title="Investigate a reported transaction" subtitle="Looks up the receipt on chain and records any transfer to a platform deposit address." />
        <InvestigateForm networks={networks.map((n) => ({ id: n.id, name: n.name }))} />
      </Card>
      <div className="mb-3 flex flex-wrap gap-2 text-xs">
        <Link href="/admin/deposits" className="rounded-full border border-line px-3 py-1 hover:border-accent">All</Link>
        {FILTERS.map((f) => <Link key={f} href={`/admin/deposits?status=${f}`} className={`rounded-full border px-3 py-1 hover:border-accent ${status === f ? 'border-accent text-fg' : 'border-line text-fg-muted'}`}>{f.replace(/_/g, ' ')}</Link>)}
      </div>
      <Card>
        <Table head={['Detected', 'User', 'Amount', 'Conf.', 'Status', 'Tx / from', 'Risk', 'Review']} empty={rows.length ? null : <EmptyState title="No deposits" />}>
          {rows.map((d) => (
            <tr key={d.id}>
              <Td className="whitespace-nowrap text-fg-muted">{dateTime(d.detected_at)}</Td>
              <Td className="text-xs">{d.user_id ? <Link className="text-accent hover:underline" href={`/admin/users/${d.user_id}`}>{d.email}</Link> : 'unattributed'}</Td>
              <Td><Money value={d.amount_base} decimals={d.decimals ?? 6} /></Td>
              <Td className="num">{d.confirmations}/{d.required_confirmations}</Td>
              <Td><DepositStatus status={d.status} />{d.is_simulated ? <> <SimulatedBadge /></> : null}{d.status_reason ? <p className="mt-1 text-xs text-fg-subtle">{d.status_reason}</p> : null}</Td>
              <Td><Mono>{shortHash(d.tx_hash)}</Mono><br /><Mono>from {shortHash(d.from_address, 4)}</Mono></Td>
              <Td>{d.risk_result ? <JsonBlock value={d.risk_result} /> : null}</Td>
              <Td className="w-80">
                {d.status === 'under_review' && d.user_id === null && d.group_wallet ? (
                  d.allocation_status === 'pending' ? (
                    <p className="text-xs text-fg-muted">Allocation posting…</p>
                  ) : (
                    <AllocationForm depositId={d.id} amountBase={d.amount_base} decimals={d.decimals ?? 6} members={members} />
                  )
                ) : d.status === 'under_review' ? (
                  <NoteAction url={`/api/admin/deposits/${d.id}/review`} options={[{ value: 'approve', label: 'Approve and credit', field: 'decision' }, { value: 'reject', label: 'Reject (recovery)', field: 'decision' }]} noteLabel="Review note" />
                ) : d.status === 'credited' && d.group_wallet ? (
                  d.correction_pending ? (
                    <p className="text-xs text-fg-muted">Correction posting…</p>
                  ) : (
                    <NoteAction url={`/api/admin/deposits/${d.id}/correct`} noteField="reason" noteLabel="Reason for reversing this credit" submitLabel="Reverse to unassigned" />
                  )
                ) : null}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
