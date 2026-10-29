import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { webDb } from '@/server/db';
import { adminUserDetail } from '@/server/queries/admin';
import { getRewardIncome, listActivity, listDeposits, listWithdrawals } from '@/server/queries/user';
import { Badge, Card, CardHeader, PageHeader, Table, Td } from '@/components/ui/primitives';
import { Money } from '@/components/ui/money';
import { DepositStatus, EVENT_LABELS, WithdrawalStatus } from '@/components/ui/status';
import { NoteAction } from '@/components/app/actions';
import { JsonBlock } from '@/components/admin/json';
import { dateTime } from '@/lib/format';
import { formatUnits } from '@/lib/money';
import { pageStaff } from '@/server/http/auth';
import { can, type StaffRole } from '@/server/permissions';
import { STAFF_ROLES } from '@/server/staff';
import { listAdjustments, operatorFloats } from '@/server/adjustments/manual';
import { BalanceEditor, ManualDepositForm, RewardForm } from '@/components/admin/adjustment-form';
import { getMembership } from '@/server/queries/user';
import { networkHistory, placementOf, teamTree } from '@/server/referrals/network';
import { effectiveProgram, rankCorrections, rankHistory } from '@/server/referrals/program';
import { PlacementForm, SponsorForm } from '@/components/admin/network-forms';
import { TeamTree } from '@/components/app/team-tree';
import { MemberDetailsForm } from '@/components/admin/member-details-form';
import { holderOfUser, MICRO_DECIMALS, offchainBalance } from '@/server/offchain/holdings';
import { OffchainSection } from '@/components/admin/offchain-section';

export const metadata: Metadata = { title: 'User detail' };

export default async function AdminUserPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const db = webDb();
  const detail = await adminUserDetail(db, id);
  if (!detail) notFound();
  const staff = await pageStaff();
  const [activity, deposits, withdrawals, adjustments, floats, bonusFunds, membership, placement, tree, history, { params: program }, ranksHeld, corrections, holder] = await Promise.all([
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
    effectiveProgram(db),
    rankHistory(db, id),
    rankCorrections(db, id),
    holderOfUser(db, id),
  ]);
  const heldBalance = holder ? await offchainBalance(db, holder.id) : 0n;
  const heldRanks = new Map(ranksHeld.map((r) => [r.rank_code, r]));
  const balanceRows = detail.balances as { token_id: number }[];
  const incomes = new Map(await Promise.all(balanceRows.map(async (b) => [Number(b.token_id), await getRewardIncome(db, id, Number(b.token_id))] as const)));
  const roles = (await db.query<{ role: StaffRole }>('select role::text as role from public.staff_roles where user_id = $1 order by role', [id])).rows.map((r) => r.role);
  const canManageStaff = can(staff.roles, 'staff.manage');
  const canAdjust = can(staff.roles, 'balance.adjust');
  const canNetwork = can(staff.roles, 'network.manage');
  const canOffchain = can(staff.roles, 'offchain.record');
  const fundOptions = [
    ...floats.map((f) => ({ fund: 'operator_float' as const, f })),
    ...bonusFunds.map((f) => ({ fund: 'referral_reward_fund' as const, f })),
  ].map(({ fund, f }) => ({ fund, tokenId: Number(f.token_id), symbol: f.symbol, balance: formatUnits(BigInt(f.balance), Number(f.decimals)) }));
  const p = detail.profile as {
    email: string;
    account_status: string;
    restriction_reason: string | null;
    display_name: string | null;
    username: string | null;
    phone: string | null;
    country_code: string | null;
    member_code: string;
  };
  const canEdit = can(staff.roles, 'member.edit');
  return (
    <>
      <PageHeader title={p.display_name || p.email} description={`${p.member_code} · ${p.username ? `@${p.username} · ` : ''}${p.email}`} />
      <div className="mb-6 grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader
            title="Edit member"
            subtitle="Name, sign-in username, phone and country. Email, member id and sponsor are changed elsewhere (sponsor below). They change their own password under Security, or reset it with Forgot password."
          />
          {canEdit ? (
            <MemberDetailsForm
              userId={id}
              initial={{ fullName: p.display_name ?? '', username: p.username ?? '', phone: p.phone ?? '', countryCode: p.country_code ?? '' }}
            />
          ) : (
            <p className="text-sm text-fg-muted">Only administrators can edit members.</p>
          )}
        </Card>
        <Card>
          <CardHeader
            title="Balance and rewards"
            subtitle="The total is what you hold for this member: it counts in their total account value but is not withdrawable. Deposits and rewards go straight to their available balance when your operator float or reward fund covers them; otherwise they are added to this total. Fix a mistake with Reverse below."
          />
          {canOffchain ? (
            <BalanceEditor
              userId={id}
              balance={formatUnits(heldBalance, MICRO_DECIMALS)}
              display={<Money value={heldBalance} decimals={MICRO_DECIMALS} symbol="USDT" />}
            />
          ) : (
            <p className="text-2xl font-semibold"><Money value={heldBalance} decimals={MICRO_DECIMALS} symbol="USDT" /></p>
          )}
          {canOffchain ? (
            <div className="mt-5 border-t border-line pt-4">
              <h3 className="mb-1 text-sm font-medium">Add deposit</h3>
              <p className="mb-3 text-xs text-fg-muted">Money they paid you personally. Shown in their deposit history.</p>
              <ManualDepositForm userId={id} floats={canAdjust ? fundOptions : []} />
            </div>
          ) : null}
          <div className="mt-5 border-t border-line pt-4">
            <h3 className="mb-3 text-sm font-medium">Add reward / interest</h3>
            {canAdjust || canOffchain ? (
              <RewardForm userId={id} floats={canAdjust ? fundOptions : []} canPersonal={canOffchain} />
            ) : (
              <p className="text-sm text-fg-muted">Only administrators can add rewards.</p>
            )}
          </div>
          {canOffchain ? (
            <div className="mt-5 border-t border-line pt-4">
              <h3 className="mb-1 text-sm font-medium">Add matching bonus</h3>
              <p className="mb-3 text-xs text-fg-muted">Added to the balance above and listed on the member&apos;s Matching bonus tab.</p>
              <RewardForm userId={id} floats={[]} canPersonal category="matching_bonus" />
            </div>
          ) : null}
        </Card>
      </div>
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
          <div className="mt-5 border-t border-line pt-4">
            <p className="mb-2 text-sm">
              <span className="text-fg-muted">Staff roles: </span>
              {roles.length ? roles.map((r) => <Badge key={r} tone="warn">{r.replace('_', ' ')}</Badge>) : <span className="text-fg-muted">none</span>}
            </p>
            {canManageStaff ? (
              <NoteAction
                url={`/api/admin/users/${id}/roles`}
                options={STAFF_ROLES.map((r) =>
                  roles.includes(r) ? { value: `revoke:${r}`, label: `Remove ${r.replace('_', ' ')} role`, field: 'change' } : { value: `grant:${r}`, label: `Make ${r.replace('_', ' ')}`, field: 'change' },
                )}
                submitLabel="Change role"
                noteLabel="Reason"
              />
            ) : null}
          </div>
        </Card>
        <Card>
          <CardHeader title="Balances (ledger)" />
          <Table head={['Token', 'Available', 'Reserved', 'Pending inv.', 'Total income']}>
            {(detail.balances as { token_id: number; cash_base: string; reserved_base: string; pending_subscription_base: string }[]).map((b) => (
              <tr key={b.token_id}>
                <Td>#{b.token_id}</Td>
                <Td><Money value={b.cash_base} decimals={6} /></Td>
                <Td><Money value={b.reserved_base} decimals={6} /></Td>
                <Td><Money value={b.pending_subscription_base} decimals={6} /></Td>
                <Td><Money value={incomes.get(Number(b.token_id)) ?? 0n} decimals={6} /></Td>
              </tr>
            ))}
          </Table>
          <p className="mt-3 text-xs text-fg-subtle">Balances are never edited in place. Use an adjustment below; every change is a ledger entry with its reason.</p>
        </Card>
        <Card>
          <CardHeader title="Investment allocation" />
          <JsonBlock value={detail.positions} />
        </Card>
      </div>
      <div className="mt-6">
        <Card>
          <CardHeader title={`Adjustments (${adjustments.length})`} />
          <Table head={['When', 'Change', 'Reason', 'Status', canAdjust ? 'Fix' : '']}>
            {adjustments.map((a) => (
              <tr key={a.id}>
                <Td className="text-fg-muted">{dateTime(a.created_at)}</Td>
                <Td><Money value={a.direction === 'credit' ? a.amount_base : `-${a.amount_base}`} decimals={Number(a.decimals)} symbol={a.symbol} signed colored /></Td>
                <Td className="max-w-xs">
                  {a.fund === 'referral_reward_fund' ? <span className="block text-xs text-fg-muted">{a.direction === 'credit' ? 'Reward / prize' : a.reverses_adjustment_id ? 'Reward reversal' : 'Reward taken back'}</span> : null}
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
      {holder ? (
        <div className="mt-6">
          <OffchainSection db={db} holder={holder} canRecord={canOffchain} showEntryForm={false} />
        </div>
      ) : null}
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
      <Card className="mt-6">
        <CardHeader
          title="Ranks"
          subtitle="Ranks held now, after corrections. Revoke a wrong rank or grant a missing one; the latest correction per rank wins, so a mistake is undone with the opposite one. Granting creates no reward: award income separately if one is owed."
        />
        <div className="flex flex-wrap gap-2">
          {program.ranks.levels.map((r) => {
            const h = heldRanks.get(r.code);
            return (
              <Badge key={r.code} tone={h ? 'success' : 'neutral'} title={h ? `${h.source} ${dateTime(h.achieved_at)}` : 'Not held'}>
                {r.code}
                {h?.source === 'granted' ? ' · granted' : ''}
              </Badge>
            );
          })}
        </div>
        {canNetwork ? (
          <div className="mt-4 max-w-md">
            <NoteAction
              url={`/api/admin/users/${id}/rank`}
              noteField="reason"
              noteLabel="Why correct this rank?"
              submitLabel="Save correction"
              options={program.ranks.levels.map((r) =>
                heldRanks.has(r.code) ? { value: `revoke:${r.code}`, label: `Revoke ${r.code}`, field: 'change' } : { value: `grant:${r.code}`, label: `Grant ${r.code}`, field: 'change' },
              )}
            />
          </div>
        ) : null}
        {corrections.length ? (
          <div className="mt-4">
            <Table head={['When', 'Correction', 'By', 'Reason']}>
              {corrections.map((c) => (
                <tr key={c.id}>
                  <Td className="text-fg-muted">{dateTime(c.created_at)}</Td>
                  <Td>
                    <Badge tone={c.action === 'grant' ? 'success' : 'warn'}>
                      {c.action} {c.rank_code}
                    </Badge>
                  </Td>
                  <Td className="text-fg-muted">{c.created_by_email ?? '—'}</Td>
                  <Td className="text-fg-muted">{c.reason}</Td>
                </tr>
              ))}
            </Table>
          </div>
        ) : null}
      </Card>
      <div className="mt-6">
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
