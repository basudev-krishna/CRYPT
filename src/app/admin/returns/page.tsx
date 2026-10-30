import type { Metadata } from 'next';
import Link from 'next/link';
import { webDb } from '@/server/db';
import { pageStaff } from '@/server/http/auth';
import { can } from '@/server/permissions';
import { many } from '@/server/db-core';
import { listActiveTokens } from '@/server/queries/user';
import { adminSubscriptions, listPlans, listRevenueRecords, returnsOverview } from '@/server/returns/service';
import { ppmToPercent } from '@/server/returns/math';
import { Badge, Card, CardHeader, EmptyState, Mono, Notice, PageHeader, Table, Td, shortHash } from '@/components/ui/primitives';
import { Money, fmt } from '@/components/ui/money';
import { Stat } from '@/components/app/stat';
import { ActionButton, NoteAction } from '@/components/app/actions';
import { FundingWalletForm, OfflinePaymentForm, OfflineSubscriptionForm, ReturnPlanForm } from '@/components/admin/return-plan-form';
import { listOfflinePayments, offlineMembers } from '@/server/returns/offline';
import { adminActiveMembers } from '@/server/queries/admin';
import { todayUtc } from '@/server/returns/math';
import { listFundingWallets } from '@/server/returns/funding';
import { dateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Daily returns' };
export const dynamic = 'force-dynamic';

const pct = (bps: bigint) => `${bps / 100n}.${String(bps % 100n).padStart(2, '0')}%`;
const PLAN_TONE = { draft: 'neutral', active: 'success', closed: 'warn' } as const;

export default async function AdminReturnsPage() {
  const staff = await pageStaff();
  const db = webDb();
  const [overview, plans, revenue, subscriptions, tokens, controls, fundingWallets, offline, offlinePayments, activeMembers] = await Promise.all([
    returnsOverview(db),
    listPlans(db),
    listRevenueRecords(db),
    adminSubscriptions(db),
    listActiveTokens(db),
    many<{ key: string; enabled: boolean }>(db, "select key, enabled from public.system_controls where key like 'return_%' order by key"),
    listFundingWallets(db),
    offlineMembers(db),
    listOfflinePayments(db),
    adminActiveMembers(db),
  ]);
  const canOffline = can(staff.roles, 'returns.offline');
  const today = todayUtc();
  const memberOptions = activeMembers.map((m) => ({ userId: m.user_id, label: `${m.member_code} · ${m.display_name ?? m.username ?? m.email ?? ''}` }));
  const activePlans = plans.filter((p) => p.status === 'active').map((p) => ({ id: p.id, label: `${p.name} (${ppmToPercent(p.daily_rate_ppm)}% / day)` }));
  const networks = [...new Map(tokens.map((t) => [t.networkId, { id: t.networkId, label: t.networkName }])).values()];
  const canConfigure = can(staff.roles, 'returns.configure');
  const paused = controls.filter((c) => c.enabled).map((c) => c.key.replace(/_/g, ' '));

  return (
    <>
      <PageHeader
        title="Daily returns"
        description="Fixed daily returns are a contractual obligation of the company, paid only from business revenue recorded against group-wallet receipts. Accrued and due amounts are promises, not money held. Credited amounts are in members' available balances; they leave the wallet only through signed withdrawals."
        actions={can(staff.roles, 'jobs.trigger') ? <ActionButton url="/api/admin/jobs" body={{ job: 'sync' }} variant="primary">Sync &amp; process now</ActionButton> : undefined}
      />

      <Notice tone="warn" title="Not approved for live use">
        Legal form, shortfall terms, capital deployment and revenue review are open decisions. See <Mono>docs/daily-returns.md</Mono> before activating a plan.
      </Notice>
      {paused.length ? (
        <div className="mt-4">
          <Notice tone="danger" title="Paused">
            {paused.join(', ')}. Change it under <Link className="text-accent hover:underline" href="/admin">Emergency controls</Link>.
          </Notice>
        </div>
      ) : null}

      {overview.length === 0 ? (
        <Card className="mt-6">
          <EmptyState title="No plans or revenue yet" />
        </Card>
      ) : (
        overview.map((o) => {
          const m = (v: bigint) => <Money value={v} decimals={o.decimals} symbol={o.symbol} />;
          return (
            <div key={o.tokenId} className="mt-6 space-y-4">
              {!o.invariantOk ? (
                <Notice tone="danger" title="Obligation books do not agree">
                  Unfunded cost {fmt(o.unfundedCost, o.decimals)} differs from accrued + due {fmt(o.accrued + o.payable, o.decimals)}. Settlement is held; reconciliation fails.
                </Notice>
              ) : null}
              {o.reserve < o.payable ? (
                <Notice tone="warn" title="Revenue shortfall">
                  Due returns exceed the revenue reserve by {fmt(o.payable - o.reserve, o.decimals)} {o.symbol}. Settlement waits for revenue; it is never paid from principal.
                </Notice>
              ) : null}
              <div className="grid gap-6 md:grid-cols-4">
                <Stat label={`Principal (${o.symbol})`} value={m(o.principal + o.offlinePrincipal)} emphasis sub={`On the platform ${fmt(o.principal, o.decimals)} · offline ${fmt(o.offlinePrincipal, o.decimals)}`} />
                <Stat label="Accrued, not yet due" value={m(o.accrued)} />
                <Stat label="Due, awaiting funding" value={m(o.payable)} />
                <Stat label="Revenue reserve" value={m(o.reserve)} sub={o.coverageBps === null ? 'Nothing due' : `Covers ${pct(o.coverageBps)} of due returns`} />
                <Stat label="Daily run rate" value={m(o.dailyRunRate)} sub={`Next 30 days: ${fmt(o.next30Days, o.decimals)} ${o.symbol}`} />
                <Stat label="Runway" value={o.runwayDays === null ? '—' : `${o.runwayDays} days`} sub="Reserve after due returns ÷ run rate" />
                <Stat label="Revenue recorded to date" value={m(o.revenueToDate)} sub={o.accruedToDate > 0n ? `${pct((o.revenueToDate * 10_000n) / o.accruedToDate)} of returns accrued to date` : undefined} />
                <Stat label="Paid to members to date" value={m(o.settledToDate)} sub={`Accrued to date: ${fmt(o.accruedToDate, o.decimals)} ${o.symbol}`} />
              </div>
            </div>
          );
        })
      )}

      <Card className="mt-6">
        <CardHeader title={`Plans (${plans.length})`} subtitle="Terms are immutable. A different administrator activates a draft (a sole administrator may, with a high-severity alert). Closing stops new subscriptions only." />
        <Table head={['Created', 'Plan', 'Rate / day', 'Minimum', 'Term', 'Due after', 'Lock', 'Terms ref.', 'Active subs', 'Status', '']} empty={plans.length ? null : <EmptyState title="No plans" />}>
          {plans.map((p) => (
            <tr key={p.id}>
              <Td className="text-fg-muted">{dateTime(p.created_at)}</Td>
              <Td>
                {p.name}
                {p.auto_enroll ? <span className="ml-1"><Badge tone="info" title="Every member deposit is enrolled automatically">auto</Badge></span> : null}
              </Td>
              <Td>{ppmToPercent(p.daily_rate_ppm)}%</Td>
              <Td><Money value={p.min_principal_base} decimals={Number(p.decimals)} symbol={p.symbol} /></Td>
              <Td>{p.term_days ? `${p.term_days} d` : 'Open'}</Td>
              <Td>{p.payable_after_days} d</Td>
              <Td>{p.principal_lock_days} d</Td>
              <Td className="max-w-48 truncate" title={p.terms_reference}>{p.terms_reference}</Td>
              <Td>{p.subscribers}</Td>
              <Td><Badge tone={PLAN_TONE[p.status]}>{p.status}</Badge></Td>
              <Td>
                {canConfigure && p.status !== 'closed' ? (
                  <NoteAction
                    url={`/api/admin/returns/plans/${p.id}`}
                    options={[...(p.status === 'draft' ? [{ value: 'activate', label: 'Activate', field: 'action' }] : []), { value: 'close', label: 'Close', field: 'action' }]}
                    submitLabel="Apply"
                    noteLabel="Note"
                  />
                ) : null}
              </Td>
            </tr>
          ))}
        </Table>
        {canConfigure ? (
          <div className="mt-6 border-t border-line pt-6">
            <h3 className="mb-3 text-sm font-medium">New draft plan</h3>
            <ReturnPlanForm tokens={tokens.map((t) => ({ id: t.id, label: `${t.symbol} · ${t.networkName}` }))} />
          </div>
        ) : null}
      </Card>

      <Card className="mt-6">
        <CardHeader
          title={`Offline members (${offline.length})`}
          subtitle="Members who handed their principal to the team offline. Their returns accrue here like everyone's and are shown in their balance; the team pays them offline and records it below. Offline plans are never paid from the on-chain reserve, and nothing here becomes withdrawable on the platform."
        />
        <Table head={['Member', 'Principal', 'Accrued', 'Due', 'Paid offline', 'Paid through', canOffline ? 'Record offline payment' : '']} empty={offline.length ? null : <EmptyState title="No offline members" />}>
          {offline.map((o) => (
            <tr key={`${o.user_id}:${o.token_id}`}>
              <Td>
                <Link className="text-accent hover:underline" href={`/admin/users/${o.user_id}`}>{o.member_code}</Link>
                {o.name ? <span className="ml-1 text-fg-muted">{o.name}</span> : null}
              </Td>
              <Td><Money value={o.principal} decimals={Number(o.decimals)} symbol={o.symbol} /></Td>
              <Td><Money value={o.accrued} decimals={Number(o.decimals)} symbol={o.symbol} /></Td>
              <Td><Money value={o.due} decimals={Number(o.decimals)} symbol={o.symbol} className={BigInt(o.due) > 0n ? 'text-warn' : undefined} /></Td>
              <Td><Money value={o.paid} decimals={Number(o.decimals)} symbol={o.symbol} /></Td>
              <Td className="text-fg-muted">{o.last_paid_through ?? '—'}</Td>
              <Td>{canOffline && BigInt(o.due) > 0n ? <OfflinePaymentForm userId={o.user_id} tokenId={Number(o.token_id)} defaultDate={today} /> : null}</Td>
            </tr>
          ))}
        </Table>
        {canOffline && activePlans.length && memberOptions.length ? (
          <div className="mt-6 border-t border-line pt-6">
            <h3 className="mb-3 text-sm font-medium">Record principal received offline</h3>
            <OfflineSubscriptionForm members={memberOptions} plans={activePlans} />
          </div>
        ) : null}
        {offlinePayments.length ? (
          <div className="mt-6 border-t border-line pt-6">
            <h3 className="mb-3 text-sm font-medium">Offline payments recorded</h3>
            <Table head={['Recorded', 'Member', 'Through', 'Amount', 'Days', 'Note', 'Status']}>
              {offlinePayments.map((p) => (
                <tr key={p.id}>
                  <Td className="text-fg-muted">{dateTime(p.created_at)}</Td>
                  <Td>{p.member_code}</Td>
                  <Td>{p.through_date}</Td>
                  <Td>{p.amount_base ? <Money value={p.amount_base} decimals={Number(p.decimals)} symbol={p.symbol} /> : '—'}</Td>
                  <Td>{p.accruals ?? '—'}</Td>
                  <Td className="max-w-56 truncate" title={p.note}>{p.note}</Td>
                  <Td><Badge tone={p.status === 'posted' ? 'success' : p.status === 'pending' ? 'info' : 'danger'} title={p.error ?? undefined}>{p.status}</Badge></Td>
                </tr>
              ))}
            </Table>
          </div>
        ) : null}
      </Card>

      <Card className="mt-6">
        <CardHeader
          title={`Funding wallets (${fundingWallets.filter((w) => w.status === 'active').length})`}
          subtitle="Your team's wallets that send USDT to the group wallet to fund daily returns. Every transfer from an active one is recorded as company funding automatically, and the day's returns are then credited to members' available balances. A member's wallet can never be registered here."
        />
        <Table head={['Added', 'Label', 'Network', 'Address', 'Received', 'Status', '']} empty={fundingWallets.length ? null : <EmptyState title="No funding wallets">Register your team’s sending wallet so daily funding is recorded automatically.</EmptyState>}>
          {fundingWallets.map((w) => (
            <tr key={w.id}>
              <Td className="text-fg-muted">{dateTime(w.created_at)}</Td>
              <Td>{w.label}</Td>
              <Td>{w.network_name}</Td>
              <Td><Mono>{shortHash(w.address, 8)}</Mono></Td>
              <Td>{w.decimals !== null ? <Money value={w.received_base} decimals={Number(w.decimals)} symbol={w.symbol ?? undefined} /> : '—'}</Td>
              <Td><Badge tone={w.status === 'active' ? 'success' : 'neutral'}>{w.status}</Badge></Td>
              <Td>
                {canConfigure && w.status === 'active' ? <NoteAction url={`/api/admin/returns/funding-wallets/${w.id}`} submitLabel="Remove" noteLabel="Reason" /> : null}
              </Td>
            </tr>
          ))}
        </Table>
        {canConfigure && networks.length ? (
          <div className="mt-6 border-t border-line pt-6">
            <FundingWalletForm networks={networks} />
          </div>
        ) : null}
      </Card>

      <Card className="mt-6">
        <CardHeader
          title={`Business revenue (${revenue.length})`}
          subtitle={
            <>
              Recorded from group-wallet receipts on the <Link className="text-accent hover:underline" href="/admin/deposits">Deposits</Link> page (allocation “Business revenue”). Refused when the sender is a member wallet. Every record raises a high-severity alert.
            </>
          }
        />
        <Table head={['Recorded', 'Business line', 'Period', 'Evidence', 'From', 'Tx', 'Amount', 'Status']} empty={revenue.length ? null : <EmptyState title="No revenue recorded" />}>
          {revenue.map((r) => (
            <tr key={r.allocation_id}>
              <Td className="text-fg-muted">{dateTime(r.created_at)}</Td>
              <Td>{r.business_line}</Td>
              <Td className="text-fg-muted">{r.period_start} – {r.period_end}</Td>
              <Td className="max-w-48 truncate" title={r.evidence_reference}>{r.evidence_reference}</Td>
              <Td><Mono>{shortHash(r.from_address, 6)}</Mono></Td>
              <Td><Mono>{shortHash(r.tx_hash)}</Mono></Td>
              <Td><Money value={r.amount_base} decimals={Number(r.decimals)} symbol={r.symbol} /></Td>
              <Td><Badge tone={r.status === 'posted' ? 'success' : r.status === 'pending' ? 'info' : 'danger'}>{r.status}</Badge></Td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card className="mt-6">
        <CardHeader title={`Subscriptions (${subscriptions.length})`} />
        <Table head={['Member', 'Plan', 'Principal', 'Opened', 'Accrued', 'Paid', 'Status', '']} empty={subscriptions.length ? null : <EmptyState title="No subscriptions" />}>
          {subscriptions.map((s) => (
            <tr key={s.id}>
              <Td>
                <Link className="text-accent hover:underline" href={`/admin/users/${s.user_id}`}>{s.member_code ?? s.email}</Link>
              </Td>
              <Td>{s.plan_name}</Td>
              <Td><Money value={s.principal_base} decimals={Number(s.decimals)} symbol={s.symbol} /></Td>
              <Td className="text-fg-muted">{s.activated_at ? dateTime(s.activated_at) : '—'}</Td>
              <Td><Money value={s.accrued_total} decimals={Number(s.decimals)} symbol={s.symbol} /></Td>
              <Td><Money value={s.settled_total} decimals={Number(s.decimals)} symbol={s.symbol} /></Td>
              <Td>
                <Badge tone={s.status === 'active' ? 'success' : s.status === 'failed' ? 'danger' : 'neutral'} title={s.error ?? undefined}>{s.status.replace('_', ' ')}</Badge>
                {s.funding === 'offline' ? <span className="ml-1"><Badge tone="neutral">offline</Badge></span> : null}
              </Td>
              <Td>
                {canOffline && s.funding === 'offline' && s.status === 'active' ? (
                  <NoteAction url={`/api/admin/returns/offline/subscriptions/${s.id}`} submitLabel="Principal returned offline" noteLabel="Who returned it, how" />
                ) : null}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
