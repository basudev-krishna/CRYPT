import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { webDb } from '@/server/db';
import { adminUserDetail } from '@/server/queries/admin';
import { listActivity, listDeposits, listWithdrawals } from '@/server/queries/user';
import { Badge, Card, CardHeader, PageHeader, Table, Td } from '@/components/ui/primitives';
import { Money } from '@/components/ui/money';
import { DepositStatus, EVENT_LABELS, WithdrawalStatus } from '@/components/ui/status';
import { NoteAction } from '@/components/app/actions';
import { JsonBlock } from '@/components/admin/json';
import { dateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'User detail' };

export default async function AdminUserPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const db = webDb();
  const detail = await adminUserDetail(db, id);
  if (!detail) notFound();
  const [activity, deposits, withdrawals] = await Promise.all([listActivity(db, id, 30), listDeposits(db, id, 20), listWithdrawals(db, id, 20)]);
  const p = detail.profile as { email: string; account_status: string; restriction_reason: string | null };
  return (
    <>
      <PageHeader title={p.email} description={`User ${id}`} />
      <div className="grid gap-6 xl:grid-cols-3">
        <Card>
          <CardHeader title="Account status" action={<Badge tone={p.account_status === 'active' ? 'success' : p.account_status === 'pending_approval' ? 'warn' : 'danger'}>{p.account_status.replace('_', ' ')}</Badge>} />
          {p.restriction_reason ? <p className="mb-3 text-sm text-fg-muted">{p.restriction_reason}</p> : null}
          {p.account_status === 'pending_approval' || p.account_status === 'rejected' ? (
            <NoteAction url={`/api/admin/users/${id}/approval`} options={[
              { value: 'approve', label: 'Approve sign-up', field: 'decision' },
              ...(p.account_status === 'pending_approval' ? [{ value: 'reject', label: 'Reject sign-up', field: 'decision' }] : []),
            ]} submitLabel="Decide" noteLabel="Documented note" />
          ) : (
            <NoteAction url={`/api/admin/users/${id}/status`} noteField="reason" options={[
              { value: 'restricted', label: 'Restrict (no deposits/withdrawals)', field: 'status' },
              { value: 'frozen', label: 'Freeze', field: 'status' },
              { value: 'active', label: 'Reactivate', field: 'status' },
            ]} submitLabel="Apply" noteLabel="Documented reason" />
          )}
        </Card>
        <Card>
          <CardHeader title="Balances (ledger)" />
          <Table head={['Token', 'Available', 'Reserved', 'Pending inv.']}>
            {(detail.balances as { token_id: number; cash_base: string; reserved_base: string; pending_subscription_base: string }[]).map((b) => (
              <tr key={b.token_id}><Td>#{b.token_id}</Td><Td><Money value={b.cash_base} decimals={6} /></Td><Td><Money value={b.reserved_base} decimals={6} /></Td><Td><Money value={b.pending_subscription_base} decimals={6} /></Td></tr>
            ))}
          </Table>
          <p className="mt-3 text-xs text-fg-subtle">Balances cannot be edited. Corrections require a documented reversal entry posted by the adjustment workflow.</p>
        </Card>
        <Card>
          <CardHeader title="Investment allocation" />
          <JsonBlock value={detail.positions} />
        </Card>
      </div>
      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title="KYC history" />
          <JsonBlock value={detail.kyc} />
        </Card>
        <Card>
          <CardHeader title="Risk events" />
          <Table head={['When', 'Kind', 'Severity', 'Status']}>
            {(detail.risk as { id: string; kind: string; severity: string; status: string; created_at: Date }[]).map((r) => (
              <tr key={r.id}><Td className="text-fg-muted">{dateTime(r.created_at)}</Td><Td>{r.kind}</Td><Td>{r.severity}</Td><Td>{r.status}</Td></tr>
            ))}
          </Table>
        </Card>
      </div>
      <Card className="mt-6">
        <CardHeader title="Ledger activity" />
        <Table head={['When', 'Event', 'Available Δ', 'Reserved Δ', 'Pending Δ']}>
          {activity.map((a) => (
            <tr key={a.entryId}><Td className="text-fg-muted">{dateTime(a.postedAt)}</Td><Td>{EVENT_LABELS[a.eventType] ?? a.eventType}</Td>
              <Td><Money value={a.cashDelta} decimals={6} signed /></Td><Td><Money value={a.reservedDelta} decimals={6} signed /></Td><Td><Money value={a.pendingDelta} decimals={6} signed /></Td></tr>
          ))}
        </Table>
      </Card>
      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card><CardHeader title="Deposits" />
          <Table head={['When', 'Amount', 'Status']}>{deposits.map((d) => <tr key={d.id}><Td className="text-fg-muted">{dateTime(d.detected_at)}</Td><Td><Money value={d.amount} decimals={d.decimals} /></Td><Td><DepositStatus status={d.status} /></Td></tr>)}</Table>
        </Card>
        <Card><CardHeader title="Withdrawals" />
          <Table head={['When', 'Amount', 'Status']}>{withdrawals.map((w) => <tr key={w.id}><Td className="text-fg-muted">{dateTime(w.created_at)}</Td><Td><Money value={w.amount} decimals={w.decimals} /></Td><Td><WithdrawalStatus status={w.status} /></Td></tr>)}</Table>
        </Card>
      </div>
    </>
  );
}
