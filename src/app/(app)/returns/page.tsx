import type { Metadata } from 'next';
import { pageUser } from '@/server/http/auth';
import { webDb } from '@/server/db';
import { userBalances } from '@/server/ledger/ledger';
import { listPlans, memberReturns, returnsOverview } from '@/server/returns/service';
import { ppmToPercent } from '@/server/returns/math';
import { isControlEnabled } from '@/server/ops';
import { Badge, Card, CardHeader, EmptyState, Notice, PageHeader, Table, Td } from '@/components/ui/primitives';
import { Money, fmt } from '@/components/ui/money';
import { Stat } from '@/components/app/stat';
import { ActionButton } from '@/components/app/actions';
import { SubscribePlanForm } from '@/components/app/returns-forms';
import { dateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Daily returns' };
export const dynamic = 'force-dynamic';

const ACCRUAL_STATUS = {
  accrued: { tone: 'neutral', label: 'Accrued, not yet due' },
  payable: { tone: 'warn', label: 'Due, not yet paid' },
  settled: { tone: 'success', label: 'Credited to available balance' },
} as const;

const SUBSCRIPTION_STATUS: Record<string, { tone: 'neutral' | 'info' | 'success' | 'warn' | 'danger'; label: string }> = {
  pending: { tone: 'info', label: 'Opening' },
  active: { tone: 'success', label: 'Active' },
  redeem_requested: { tone: 'info', label: 'Principal being returned' },
  redeemed: { tone: 'neutral', label: 'Principal returned' },
  failed: { tone: 'danger', label: 'Not opened' },
  cancelled: { tone: 'neutral', label: 'Cancelled' },
};

/** Share as a percentage string from basis points (capped display at 100%+). */
const pct = (bps: bigint) => `${bps / 100n}.${String(bps % 100n).padStart(2, '0')}%`;

export default async function ReturnsPage() {
  const user = await pageUser();
  const db = webDb();
  const [mine, plans, balances, overview, settlementsPaused] = await Promise.all([
    memberReturns(db, user.id),
    listPlans(db, { offeredOnly: true }),
    userBalances(db, user.id),
    returnsOverview(db),
    isControlEnabled(db, 'return_settlements_paused'),
  ]);
  const t = mine.totals[0];
  const cash = (tokenId: number) => balances.find((b) => b.tokenId === tokenId)?.cash ?? 0n;

  return (
    <>
      <PageHeader
        title="Daily returns"
        description="A plan pays a fixed daily rate on your principal under its written terms. This is the company's promise, not trading profit. It is paid only from company revenue. Accrued and due returns are not money in your balance until they are credited."
      />

      <div className="grid gap-6 md:grid-cols-3 xl:grid-cols-6">
        <Stat
          label="Principal"
          value={t ? <Money value={BigInt(t.principal) + BigInt(t.offline_principal)} decimals={Number(t.decimals)} symbol={t.symbol} /> : '—'}
          emphasis
          sub={t && BigInt(t.offline_principal) > 0n ? `Includes ${fmt(t.offline_principal, Number(t.decimals))} handed to the team offline` : undefined}
        />
        <Stat label="Daily return" value={t ? <Money value={t.daily} decimals={Number(t.decimals)} symbol={t.symbol} maxFraction={4} /> : '—'} sub="Accrued each UTC day" />
        <Stat label="Accrued" value={t ? <Money value={t.accrued} decimals={Number(t.decimals)} symbol={t.symbol} /> : '—'} sub="Not yet due" />
        <Stat label="Due" value={t ? <Money value={t.payable} decimals={Number(t.decimals)} symbol={t.symbol} /> : '—'} sub="Waiting to be paid" />
        <Stat label="Credited" value={t ? <Money value={t.settled} decimals={Number(t.decimals)} symbol={t.symbol} /> : '—'} sub="Added to your available balance" />
        <Stat label="Paid offline" value={t ? <Money value={t.paid_offline} decimals={Number(t.decimals)} symbol={t.symbol} /> : '—'} sub="Paid to you by the team, outside the platform" />
      </div>

      {overview.map((o) =>
        o.payable > 0n || settlementsPaused ? (
          <div key={o.tokenId} className="mt-6">
            <Notice tone={settlementsPaused || o.reserve < o.payable ? 'warn' : 'info'} title="Funding status">
              {settlementsPaused ? 'Payment of due returns is paused by an administrator. Accrual continues. ' : null}
              {o.coverageBps !== null ? `Company revenue set aside covers ${pct(o.coverageBps)} of the returns now due across all members. ` : null}
              {o.accruedToDate > 0n ? `Revenue recorded so far equals ${pct((o.revenueToDate * 10_000n) / o.accruedToDate)} of all returns accrued so far. ` : null}
              Due returns are paid oldest first as revenue arrives.
            </Notice>
          </div>
        ) : null,
      )}

      <Card className="mt-6">
        <CardHeader title="Plans" subtitle="Terms are fixed when a plan is created and never edited. Your principal stays in the group wallet." />
        {plans.length === 0 ? (
          <EmptyState title="No plan is open">An administrator has not opened a plan yet.</EmptyState>
        ) : (
          <div className="space-y-5">
            {plans.map((p) => (
              <div key={p.id} className="rounded-2xl bg-surface-3/50 p-4 ring-1 ring-black/5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-heading text-lg">{p.name}</span>
                  <span className="text-sm text-fg-muted">Terms ref. {p.terms_reference}</span>
                </div>
                <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-5">
                  {(
                    [
                      ['Daily rate', `${ppmToPercent(p.daily_rate_ppm)}% of principal`],
                      ['Minimum', `${fmt(p.min_principal_base, Number(p.decimals))} ${p.symbol}`],
                      ['Term', p.term_days ? `${p.term_days} days` : 'No fixed term'],
                      ['Due', p.payable_after_days === 0 ? 'Day after it is earned' : `${p.payable_after_days} days after it is earned`],
                      ['Principal lock', `${p.principal_lock_days} days`],
                    ] as const
                  ).map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-fg-muted">{label}</dt>
                      <dd className="font-medium">{value}</dd>
                    </div>
                  ))}
                </dl>
                <div className="mt-4">
                  <SubscribePlanForm
                    planId={p.id}
                    symbol={p.symbol}
                    minDisplay={fmt(p.min_principal_base, Number(p.decimals))}
                    availableDisplay={fmt(cash(Number(p.token_id)), Number(p.decimals))}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="mt-6">
        <CardHeader title={`Your subscriptions (${mine.subscriptions.length})`} />
        <Table head={['Requested', 'Plan', 'Principal', 'Rate', 'Accrual', 'Status', '']} empty={mine.subscriptions.length ? null : <EmptyState title="No subscriptions yet" />}>
          {mine.subscriptions.map((s) => {
            const st = SUBSCRIPTION_STATUS[s.status] ?? { tone: 'neutral' as const, label: s.status };
            return (
              <tr key={s.id}>
                <Td className="text-fg-muted">{dateTime(s.requested_at)}</Td>
                <Td>{s.plan_name}</Td>
                <Td><Money value={s.principal_base} decimals={Number(s.decimals)} symbol={s.symbol} /></Td>
                <Td>{ppmToPercent(s.daily_rate_ppm)}% / day</Td>
                <Td className="text-fg-muted">{s.accrual_start_date ? `from ${s.accrual_start_date}${s.accrual_end_date ? ` to ${s.accrual_end_date} (excl.)` : ''}` : '—'}</Td>
                <Td>
                  <Badge tone={st.tone} title={s.error ?? undefined}>{st.label}</Badge>
                  {s.funding === 'offline' ? <span className="ml-1"><Badge tone="neutral" title="Principal handed to the team offline; returned offline by the team">Offline</Badge></span> : null}
                </Td>
                <Td>
                  {s.status === 'pending' ? <ActionButton url={`/api/returns/${s.id}`} body={{ action: 'cancel' }} confirmText="Cancel this subscription request?">Cancel</ActionButton> : null}
                  {s.status === 'active' && s.funding === 'offline' ? <span className="text-xs text-fg-muted">The team returns this principal</span> : null}
                  {s.status === 'active' && s.funding === 'platform' ? (
                    s.unlocked ? (
                      <ActionButton url={`/api/returns/${s.id}`} body={{ action: 'redeem' }} confirmText="Request your principal back? Accrual stops today and the principal returns to your available balance.">
                        Return principal
                      </ActionButton>
                    ) : (
                      <span className="text-xs text-fg-muted">Locked until {dateTime(s.unlock_at)}</span>
                    )
                  ) : null}
                </Td>
              </tr>
            );
          })}
        </Table>
      </Card>

      <Card className="mt-6">
        <CardHeader title="Daily accruals" subtitle="Each line is one UTC day: principal × daily rate, rounded down. Credited means added to your available balance (it reaches your wallet when you withdraw); paid offline means the team paid you outside the platform." />
        <Table head={['Day', 'Principal', 'Rate', 'Return', 'Due on', 'Status', 'Credited']} empty={mine.accruals.length ? null : <EmptyState title="No accruals yet">The first day accrues the day after your subscription opens.</EmptyState>}>
          {mine.accruals.map((a) => (
            <tr key={a.id}>
              <Td>{a.accrual_date}</Td>
              <Td><Money value={a.principal_base} decimals={Number(a.decimals)} symbol={a.symbol} /></Td>
              <Td>{ppmToPercent(a.daily_rate_ppm)}%</Td>
              <Td><Money value={a.amount_base} decimals={Number(a.decimals)} symbol={a.symbol} maxFraction={6} /></Td>
              <Td className="text-fg-muted">{a.payable_on}</Td>
              <Td>
                {a.paid_offline ? <Badge tone="success">Paid offline by the team</Badge> : <Badge tone={ACCRUAL_STATUS[a.status].tone}>{ACCRUAL_STATUS[a.status].label}</Badge>}
              </Td>
              <Td className="text-fg-muted">{a.settled_at ? dateTime(a.settled_at) : '—'}</Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
