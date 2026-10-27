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
import { formatUnits } from '@/lib/money';
import { pageStaff } from '@/server/http/auth';
import { can } from '@/server/permissions';
import { listAdjustments, operatorFloats } from '@/server/adjustments/manual';
import { AdjustmentForm } from '@/components/admin/adjustment-form';
import { getMembership } from '@/server/queries/user';
import { networkHistory, placementOf, teamTree } from '@/server/referrals/network';
import { PlacementForm, SponsorForm } from '@/components/admin/network-forms';
import { TeamTree } from '@/components/app/team-tree';

export const metadata: Metadata = { title: 'User detail' };

export default async function AdminUserPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const db = webDb();
  const detail = await adminUserDetail(db, id);
  if (!detail) notFound();
  const staff = await pageStaff();
  const [activity, deposits, withdrawals, adjustments, floats, bonusFunds, membership, placement, tree, history] = await Promise.all([
    listActivity(db, id, 30),
    listDeposits(db, id, 20),
    listWithdrawals(db, id, 20),
    listAdjustments(db, id),
    operatorFloats(db),
    operatorFloats(db, 'referral_reward_fund'),
    getMembership(db, id),
    placementOf(db, id),
    teamTree(db, id, 3),
    networkHistory(db, id),
  ]);
  const canAdjust = can(staff.roles, 'balance.adjust');
  const canNetwork = can(staff.roles, 'network.manage');
  const fundOptions = [
    ...floats.map((f) => ({ fund: 'operator_float' as const, f })),
    ...bonusFunds.map((f) => ({ fund: 'referral_reward_fund' as const, f })),
  ].map(({ fund, f }) => ({ fund, tokenId: Number(f.token_id), symbol: f.symbol, balance: formatUnits(BigInt(f.balance), Number(f.decimals)) }));
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
          <p className="mt-3 text-xs text-fg-subtle">Balances are never edited in place. Use an adjustment below; every change is a ledger entry with its reason.</p>
        </Card>
        <Card>
          <CardHeader title="Investment allocation" />
          <JsonBlock value={detail.positions} />
        </Card>
      </div>
      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader
            title="Adjust balance"
            subtitle="For money settled with you personally. Credits come from your operator float and debits go back to it, so the group wallet always covers every balance."
          />
          {canAdjust ? <AdjustmentForm userId={id} floats={fundOptions} /> : <p className="text-sm text-fg-muted">Only administrators can adjust balances.</p>}
        </Card>
        <Card>
          <CardHeader title={`Adjustments (${adjustments.length})`} />
          <Table head={['When', 'Change', 'Reason', 'Status', canAdjust ? 'Fix' : '']}>
            {adjustments.map((a) => (
              <tr key={a.id}>
                <Td className="text-fg-muted">{dateTime(a.created_at)}</Td>
                <Td><Money value={a.direction === 'credit' ? a.amount_base : `-${a.amount_base}`} decimals={Number(a.decimals)} symbol={a.symbol} signed colored /></Td>
                <Td className="max-w-xs">
                  {a.fund === 'referral_reward_fund' ? <span className="block text-xs text-fg-muted">Referral bonus</span> : null}
                  {a.reason}
                  {a.error ? <span className="block text-xs text-loss">{a.error}</span> : null}
                </Td>
                <Td><Badge tone={a.status === 'posted' ? 'success' : a.status === 'pending' ? 'warn' : 'neutral'}>{a.reversed ? 'reversed' : a.status}</Badge></Td>
                <Td className="min-w-48">
                  {canAdjust && a.status === 'pending' ? <NoteAction url={`/api/admin/adjustments/${a.id}/cancel`} noteField="reason" noteLabel="Why cancel?" submitLabel="Cancel" /> : null}
                  {canAdjust && a.status === 'posted' && !a.reversed && !a.reverses_adjustment_id ? <NoteAction url={`/api/admin/adjustments/${a.id}/reverse`} noteField="reason" noteLabel="Why reverse?" submitLabel="Reverse" /> : null}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader
            title="Referral and team position"
            subtitle={`Member ${membership?.memberCode ?? ''} · referred by ${membership?.sponsorMemberCode ?? 'nobody'} · ${placement ? `${placement.side} of ${placement.parent_code}` : 'not placed in the team tree'}`}
          />
          {canNetwork ? (
            <div className="space-y-6">
              <SponsorForm userId={id} current={membership?.sponsorMemberCode ?? null} />
              <div className="border-t border-line pt-4">
                <PlacementForm userId={id} parent={placement?.parent_code ?? null} side={placement?.side ?? null} />
              </div>
              {placement ? (
                <NoteAction url={`/api/admin/users/${id}/placement/remove`} noteField="reason" noteLabel="Why remove from the tree?" submitLabel="Remove position" />
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-fg-muted">Only administrators can change referrals and positions.</p>
          )}
        </Card>
        <Card>
          <CardHeader title="Team" subtitle="Their left and right team, three levels shown." />
          {tree ? <TeamTree node={tree} hrefFor={(n) => `/admin/users/${n.userId}`} /> : null}
          {history.length ? (
            <div className="mt-4">
              <Table head={['When', 'Change', 'Detail', 'Reason']}>
                {history.map((h, i) => (
                  <tr key={i}>
                    <Td className="text-fg-muted">{dateTime(h.at)}</Td>
                    <Td>{h.kind === 'sponsor' ? 'Referrer' : 'Position'}</Td>
                    <Td className="font-mono text-xs">{h.detail}</Td>
                    <Td className="text-fg-muted">{h.reason}</Td>
                  </tr>
                ))}
              </Table>
            </div>
          ) : null}
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
