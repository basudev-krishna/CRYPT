import type { Metadata } from 'next';
import Link from 'next/link';
import { webDb } from '@/server/db';
import { adminOverview } from '@/server/queries/admin';
import { Badge, Card, CardHeader, Notice, PageHeader, SimulatedBadge } from '@/components/ui/primitives';
import { Money } from '@/components/ui/money';
import { Stat } from '@/components/app/stat';
import { NoteAction, ActionButton } from '@/components/app/actions';
import { dateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Staff console' };
const DEC = 6;

export default async function AdminOverviewPage() {
  const o = await adminOverview(webDb());
  const surplus = o.treasuryAssets + o.poolAssets - o.customerLiabilities;
  return (
    <>
      <PageHeader title="Operations overview" description="Ledger-derived platform position. Amounts in tUSDT base units formatted to 2 dp." />
      {o.controls.some((c) => c.enabled) ? (
        <div className="mb-6">
          <Notice tone="danger" title="Emergency controls active">
            {o.controls.filter((c) => c.enabled).map((c) => (
              <div key={c.key}>{c.key.replace(/_/g, ' ')} — {c.reason} (by {c.updated_by}, {dateTime(c.updated_at)})</div>
            ))}
          </Notice>
        </div>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Users" value={o.users} sub={<Link className="text-accent hover:underline" href="/admin/compliance">{o.kycPending} KYC pending review</Link>} />
        <Stat label="Credited deposits" value={o.depositsCredited} sub={<><Money value={o.depositsCreditedSum} decimals={DEC} /> · {o.depositsOpen} open</>} />
        <Stat label="Pending withdrawals" value={o.withdrawalsOpen} sub={<><Money value={o.withdrawalsOpenSum} decimals={DEC} /> · {o.withdrawalsReview} awaiting review</>} />
        <Stat label="Reconciliation" value={o.reconciliation ? <Badge tone={o.reconciliation.status === 'ok' ? 'success' : o.reconciliation.status === 'running' ? 'info' : 'danger'}>{o.reconciliation.status}</Badge> : <Badge>never run</Badge>}
          sub={o.reconciliation ? dateTime(o.reconciliation.started_at) : null} />
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Treasury assets (ledger)" value={<Money value={o.treasuryAssets} decimals={DEC} />} />
        <Stat label="Pool assets (venue)" value={<Money value={o.poolAssets} decimals={DEC} />} badge={o.nav?.isSimulated ? <SimulatedBadge /> : null} />
        <Stat label="Customer liabilities" value={<Money value={o.customerLiabilities} decimals={DEC} />} sub={<>Surplus <Money value={surplus} decimals={DEC} signed colored /></>} />
        <Stat label="Portfolio NAV" value={o.nav ? <Money value={o.nav.nav} decimals={DEC} /> : '—'} badge={o.nav?.isSimulated ? <SimulatedBadge /> : null}
          sub={o.nav ? <>Realized <Money value={o.nav.realized} decimals={DEC} signed colored /> · Unrealized <Money value={o.nav.unrealized} decimals={DEC} signed colored /></> : 'No valuation yet'} />
      </div>
      {o.lastValuation?.status === 'failed' ? <div className="mt-4"><Notice tone="warn" title="Latest valuation failed">{o.lastValuation.failure_reason} at {dateTime(o.lastValuation.valued_at)}</Notice></div> : null}

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title="Risk & system alerts" action={<Link href="/admin/compliance" className="text-xs text-accent hover:underline">Review →</Link>} />
          <div className="flex flex-wrap gap-2">
            {(['critical', 'high', 'medium', 'low', 'info'] as const).map((s) => (
              <Badge key={s} tone={s === 'critical' || s === 'high' ? 'danger' : s === 'medium' ? 'warn' : 'neutral'}>{s}: {o.risk[s] ?? 0}</Badge>
            ))}
          </div>
          <div className="mt-5 flex flex-wrap gap-2">
            <ActionButton url="/api/admin/jobs" body={{ job: 'reconciliation' }}>Run reconciliation</ActionButton>
            <ActionButton url="/api/admin/jobs" body={{ job: 'trades' }}>Import trades</ActionButton>
            <ActionButton url="/api/admin/jobs" body={{ job: 'valuation' }}>Run valuation</ActionButton>
          </div>
        </Card>
        <Card>
          <CardHeader title="Emergency controls" subtitle="Any on-duty staff can pause. Resuming requires a different administrator (four-eyes)." />
          <div className="space-y-4">
            {o.controls.map((c) => (
              <div key={c.key} className="rounded-lg border border-line p-3">
                <div className="mb-2 flex items-center justify-between text-sm">
                  <span className="capitalize">{c.key.replace(/_/g, ' ')}</span>
                  {c.enabled ? <Badge tone="danger">Active</Badge> : <Badge tone="success">Off</Badge>}
                </div>
                <NoteAction url="/api/admin/controls" extra={{ key: c.key }} noteField="reason"
                  options={[{ value: c.enabled ? 'false' : 'true', label: c.enabled ? 'Resume' : 'Pause', field: 'enabled' }]}
                  submitLabel={c.enabled ? 'Resume' : 'Pause'} noteLabel="Reason" />
              </div>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}
