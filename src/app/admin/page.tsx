import type { Metadata } from 'next';
import Link from 'next/link';
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Landmark, PauseCircle, PlayCircle, RefreshCw, Scale, ShieldCheck, UserCheck, Users } from 'lucide-react';
import { webDb } from '@/server/db';
import { pageStaff } from '@/server/http/auth';
import { can } from '@/server/permissions';
import { adminOverview, adminSignupQueue, signupStats } from '@/server/queries/admin';
import { Badge, Card, CardHeader, Notice, PageHeader, SimulatedBadge } from '@/components/ui/primitives';
import { Money, fmt } from '@/components/ui/money';
import { Stat } from '@/components/app/stat';
import { NoteAction, ActionButton } from '@/components/app/actions';
import { ApprovalQueue } from '@/components/admin/approval-queue';
import { ShareBars, SignupBars } from '@/components/charts/value-chart';
import { Reveal, Stagger, StaggerItem } from '@/components/ui/motion';
import { baseToChart, dateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Staff console' };
export const dynamic = 'force-dynamic';
const DEC = 6;

// Status colours carry a label and count, never colour alone.
const SEVERITIES = [
  { key: 'critical', label: 'Critical', bar: 'bg-loss' },
  { key: 'high', label: 'High', bar: 'bg-loss/70' },
  { key: 'medium', label: 'Medium', bar: 'bg-warn' },
  { key: 'low', label: 'Low', bar: 'bg-fg-subtle' },
  { key: 'info', label: 'Info', bar: 'bg-line-strong' },
] as const;

export default async function AdminOverviewPage() {
  const staff = await pageStaff();
  const db = webDb();
  const [o, queue, signups] = await Promise.all([adminOverview(db), adminSignupQueue(db), signupStats(db)]);
  const surplus = o.treasuryAssets + o.poolAssets - o.customerLiabilities;
  const openRisk = SEVERITIES.reduce((n, s) => n + (o.risk[s.key] ?? 0), 0);
  const position = [
    { label: 'Treasury assets (ledger)', amount: o.treasuryAssets },
    { label: 'Pool assets (venue)', amount: o.poolAssets },
    { label: 'Customer liabilities', amount: o.customerLiabilities },
    { label: 'Fee revenue', amount: o.feeRevenue },
  ].map((r) => ({ label: r.label, value: baseToChart(r.amount, DEC), display: fmt(r.amount, DEC) }));
  const reconTone = o.reconciliation ? (o.reconciliation.status === 'ok' ? 'success' : o.reconciliation.status === 'running' ? 'info' : 'danger') : 'neutral';

  return (
    <>
      <Reveal>
        <PageHeader
          title="Operations overview"
          description="Ledger-derived platform position, live queues and emergency controls. Amounts in tUSDT, 2 dp."
          actions={can(staff.roles, 'jobs.trigger') ? <ActionButton url="/api/admin/jobs" body={{ job: 'reconciliation' }}>Run reconciliation</ActionButton> : undefined}
        />
      </Reveal>

      {o.controls.some((c) => c.enabled) ? (
        <div className="mb-6">
          <Notice tone="danger" title="Emergency controls active">
            {o.controls.filter((c) => c.enabled).map((c) => (
              <div key={c.key}>{c.key.replace(/_/g, ' ')} — {c.reason} (by {c.updated_by}, {dateTime(c.updated_at)})</div>
            ))}
          </Notice>
        </div>
      ) : null}

      <Stagger className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StaggerItem>
          <Link href="/admin/approvals" className="block">
            <Stat emphasis icon={UserCheck} label="Awaiting approval" value={signups.pending} sub={signups.oldestPending ? `Oldest since ${dateTime(signups.oldestPending)}` : 'Queue is clear'} />
          </Link>
        </StaggerItem>
        <StaggerItem>
          <Stat icon={Users} label="Members" value={o.users} />
        </StaggerItem>
        <StaggerItem>
          <Stat icon={ArrowDownToLine} label="Credited deposits" value={o.depositsCredited} sub={<><Money value={o.depositsCreditedSum} decimals={DEC} /> · {o.depositsOpen} open</>} />
        </StaggerItem>
        <StaggerItem>
          <Stat icon={ArrowUpFromLine} label="Pending withdrawals" value={o.withdrawalsOpen} sub={<><Money value={o.withdrawalsOpenSum} decimals={DEC} /> · {o.withdrawalsReview} awaiting review</>} />
        </StaggerItem>
      </Stagger>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <Reveal className="xl:col-span-2">
          <Card className="h-full">
            <CardHeader
              title={<span className="flex items-center gap-2">Sign-up approvals {signups.pending > 0 ? <Badge tone="warn">{signups.pending} waiting</Badge> : <Badge tone="success">clear</Badge>}</span>}
              subtitle={`${signups.approved7d} approved · ${signups.rejected7d} rejected in the last 7 days`}
              action={<Link href="/admin/approvals" className="text-xs font-medium text-accent hover:underline">Open queue →</Link>}
            />
            <ApprovalQueue rows={queue} canDecide={can(staff.roles, 'user.approve')} compact />
          </Card>
        </Reveal>
        <Reveal delay={0.08}>
          <Card className="h-full">
            <CardHeader title="New sign-ups" subtitle="Per day, last 14 days (UTC). Hover a bar for the count." />
            <SignupBars data={signups.daily} />
          </Card>
        </Reveal>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <Reveal className="xl:col-span-2">
          <Card className="h-full">
            <CardHeader
              title={<span className="flex items-center gap-2"><Scale size={16} className="text-accent" aria-hidden /> Platform position</span>}
              subtitle="Assets against what is owed to customers, straight from the ledger"
              action={o.nav?.isSimulated ? <SimulatedBadge /> : null}
            />
            <ShareBars rows={position} />
            <div className="mt-5 grid gap-3 border-t border-line pt-4 sm:grid-cols-3">
              <div>
                <p className="text-xs text-fg-muted">Surplus</p>
                <p className="font-heading text-lg"><Money value={surplus} decimals={DEC} signed colored /></p>
              </div>
              <div>
                <p className="text-xs text-fg-muted">Portfolio NAV</p>
                <p className="font-heading text-lg">{o.nav ? <Money value={o.nav.nav} decimals={DEC} /> : '—'}</p>
              </div>
              <div>
                <p className="text-xs text-fg-muted">Realized · unrealized</p>
                <p className="text-sm">{o.nav ? <><Money value={o.nav.realized} decimals={DEC} signed colored /> · <Money value={o.nav.unrealized} decimals={DEC} signed colored /></> : 'No valuation yet'}</p>
              </div>
            </div>
            {o.lastValuation?.status === 'failed' ? <div className="mt-4"><Notice tone="warn" title="Latest valuation failed">{o.lastValuation.failure_reason} at {dateTime(o.lastValuation.valued_at)}</Notice></div> : null}
          </Card>
        </Reveal>
        <Reveal delay={0.08}>
          <Card className="h-full">
            <CardHeader
              title={<span className="flex items-center gap-2"><AlertTriangle size={16} className="text-warn" aria-hidden /> Open risk events</span>}
              subtitle={`${openRisk} unresolved`}
              action={<Link href="/admin/compliance" className="text-xs font-medium text-accent hover:underline">Review →</Link>}
            />
            <ul className="space-y-2.5">
              {SEVERITIES.map((s) => {
                const n = o.risk[s.key] ?? 0;
                return (
                  <li key={s.key} className="group">
                    <div className="mb-1 flex justify-between text-sm">
                      <span className="text-fg-muted">{s.label}</span>
                      <span className="num font-medium">{n}</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-surface-3">
                      <div className={`h-full rounded-full transition-[width] duration-700 ${s.bar}`} style={{ width: `${openRisk ? Math.max((n / openRisk) * 100, n ? 4 : 0) : 0}%` }} />
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="mt-5 flex items-center justify-between rounded-xl bg-surface-3/60 px-3 py-2.5 text-sm">
              <span className="flex items-center gap-2 text-fg-muted"><ShieldCheck size={15} aria-hidden /> Reconciliation</span>
              <span className="flex items-center gap-2">
                <Badge tone={reconTone}>{o.reconciliation?.status ?? 'never run'}</Badge>
                {o.reconciliation ? <span className="text-xs text-fg-subtle">{dateTime(o.reconciliation.started_at)}</span> : null}
              </span>
            </div>
          </Card>
        </Reveal>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Reveal>
          <Card className="h-full">
            <CardHeader title={<span className="flex items-center gap-2"><RefreshCw size={16} className="text-accent" aria-hidden /> Jobs</span>} subtitle="Run a background job now instead of waiting for the schedule" />
            <div className="flex flex-wrap gap-2">
              <ActionButton url="/api/admin/jobs" body={{ job: 'reconciliation' }}>Run reconciliation</ActionButton>
              <ActionButton url="/api/admin/jobs" body={{ job: 'trades' }}>Import trades</ActionButton>
              <ActionButton url="/api/admin/jobs" body={{ job: 'valuation' }}>Run valuation</ActionButton>
            </div>
            <p className="mt-4 flex items-center gap-2 text-xs text-fg-subtle"><Landmark size={13} aria-hidden /> Fee revenue to date: <Money value={o.feeRevenue} decimals={DEC} /></p>
          </Card>
        </Reveal>
        <Reveal delay={0.08}>
          <Card className="h-full">
            <CardHeader title="Emergency controls" subtitle="Any on-duty staff can pause. Resuming requires a different administrator (four-eyes)." />
            <div className="space-y-3">
              {o.controls.map((c) => (
                <details key={c.key} className="group rounded-2xl border border-line bg-white/60 p-3 open:bg-white">
                  <summary className="flex cursor-pointer list-none items-center justify-between text-sm">
                    <span className="flex items-center gap-2 capitalize">
                      {c.enabled ? <PauseCircle size={16} className="text-loss" aria-hidden /> : <PlayCircle size={16} className="text-gain" aria-hidden />}
                      {c.key.replace(/_/g, ' ')}
                    </span>
                    <span className="flex items-center gap-2">
                      {c.enabled ? <Badge tone="danger">Paused</Badge> : <Badge tone="success">Running</Badge>}
                      <span className="text-xs text-fg-subtle group-open:hidden">Change ▾</span>
                    </span>
                  </summary>
                  <div className="mt-3">
                    <NoteAction url="/api/admin/controls" extra={{ key: c.key }} noteField="reason"
                      options={[{ value: c.enabled ? 'false' : 'true', label: c.enabled ? 'Resume' : 'Pause', field: 'enabled' }]}
                      submitLabel={c.enabled ? 'Resume' : 'Pause'} noteLabel="Reason" />
                  </div>
                </details>
              ))}
            </div>
          </Card>
        </Reveal>
      </div>
    </>
  );
}
