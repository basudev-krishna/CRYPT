'use client';
import clsx from 'clsx';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { apiPost } from '@/lib/api-client';
import { Badge, Button, EmptyState, Input, Mono, Notice, Textarea } from '@/components/ui/primitives';

export interface QueueRow {
  userId: string;
  email: string;
  memberCode: string;
  fullName: string | null;
  username: string | null;
  phone: string | null;
  country: string | null;
  referredBy: string | null;
  status: string;
  reason: string | null;
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
}

type Tab = 'pending' | 'rejected' | 'decided';
type Decision = 'approve' | 'reject';

const QUICK_NOTES: Record<Decision, string[]> = {
  approve: ['Known to the team; identity confirmed', 'Verified by phone with the applicant', 'Referred by an existing member'],
  reject: ['Unable to verify the applicant', 'Duplicate account', 'Does not meet membership criteria'],
};

const REFRESH_MS = 30_000;

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * Interactive sign-up queue: filter, select, and approve or reject one or many
 * accounts with a documented note. Every decision is a separate server call
 * that re-checks permission, status and self-review; the list then refreshes
 * from the server, so nothing here is trusted as the source of truth.
 */
export function ApprovalQueue({ rows, canDecide, compact = false }: { rows: QueueRow[]; canDecide: boolean; compact?: boolean }) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('pending');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [panel, setPanel] = useState<{ decision: Decision; ids: string[] } | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<{ ok: number; failed: { email: string; error: string }[] } | null>(null);
  const [live, setLive] = useState(true);

  // Pick up new sign-ups without a manual reload, but never while a decision is being written.
  useEffect(() => {
    if (!live || panel || busy) return;
    const t = setInterval(() => router.refresh(), REFRESH_MS);
    return () => clearInterval(t);
  }, [live, panel, busy, router]);

  const counts = useMemo(
    () => ({
      pending: rows.filter((r) => r.status === 'pending_approval' && !done.has(r.userId)).length,
      rejected: rows.filter((r) => r.status === 'rejected').length,
      decided: rows.filter((r) => r.reviewedAt && r.status !== 'pending_approval').length,
    }),
    [rows, done],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows
      .filter((r) =>
        tab === 'pending' ? r.status === 'pending_approval' && !done.has(r.userId) : tab === 'rejected' ? r.status === 'rejected' : Boolean(r.reviewedAt) && r.status !== 'pending_approval',
      )
      .filter((r) => !q || [r.email, r.memberCode, r.fullName, r.username, r.phone].some((v) => v?.toLowerCase().includes(q)))
      .slice(0, compact ? 5 : undefined);
  }, [rows, tab, query, done, compact]);

  const selectable = canDecide && (tab === 'pending' || tab === 'rejected');
  const selectedVisible = visible.filter((r) => selected.has(r.userId));
  const allSelected = visible.length > 0 && selectedVisible.length === visible.length;

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const open = (decision: Decision, ids: string[]) => {
    setPanel({ decision, ids });
    setNote('');
    setResult(null);
  };

  const submit = async () => {
    if (!panel) return;
    setBusy(true);
    const failed: { email: string; error: string }[] = [];
    let ok = 0;
    // One request per account keeps each decision separately checked and audited.
    for (const id of panel.ids) {
      const r = await apiPost(`/api/admin/users/${id}/approval`, { decision: panel.decision, note: note.trim() });
      if (r.ok) {
        ok++;
        setDone((d) => new Set(d).add(id));
      } else {
        failed.push({ email: rows.find((x) => x.userId === id)?.email ?? id, error: r.error ?? 'Failed' });
      }
    }
    setBusy(false);
    setResult({ ok, failed });
    setSelected(new Set());
    if (failed.length === 0) setPanel(null);
    router.refresh();
  };

  const panelEmails = panel ? panel.ids.map((id) => rows.find((r) => r.userId === id)?.email ?? id) : [];

  return (
    <div className="space-y-4">
      {!compact ? (
        <div className="flex flex-wrap items-center gap-3">
          <div role="tablist" aria-label="Sign-up status" className="inline-flex rounded-lg border border-line bg-surface-3/40 p-0.5">
            {(['pending', 'rejected', 'decided'] as const).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                onClick={() => {
                  setTab(t);
                  setSelected(new Set());
                }}
                className={clsx('rounded-md px-3 py-1.5 text-xs font-medium capitalize transition-colors', tab === t ? 'bg-accent text-white' : 'text-fg-muted hover:text-fg')}
              >
                {t === 'decided' ? 'Decided (30d)' : t} <span className="ml-1 opacity-80">{counts[t]}</span>
              </button>
            ))}
          </div>
          <label htmlFor="queue-search" className="sr-only">
            Search sign-ups
          </label>
          <Input id="queue-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, username, email, phone or member id" className="h-9 max-w-xs text-sm" />
          <label className="ml-auto flex items-center gap-2 text-xs text-fg-muted">
            <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
            Auto-refresh every 30 s
          </label>
        </div>
      ) : null}

      {result && !panel ? (
        <Notice tone={result.failed.length ? 'warn' : 'success'}>
          {result.ok} account{result.ok === 1 ? '' : 's'} updated.
          {result.failed.map((f) => (
            <div key={f.email}>
              {f.email}: {f.error}
            </div>
          ))}
        </Notice>
      ) : null}

      {selectable && selectedVisible.length > 0 && !panel ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-sm">
          <span>{selectedVisible.length} selected</span>
          <Button className="h-8 px-3 text-xs" onClick={() => open('approve', selectedVisible.map((r) => r.userId))}>
            Approve selected
          </Button>
          {tab === 'pending' ? (
            <Button variant="danger" className="h-8 px-3 text-xs" onClick={() => open('reject', selectedVisible.map((r) => r.userId))}>
              Reject selected
            </Button>
          ) : null}
          <Button variant="ghost" className="h-8 px-3 text-xs" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      ) : null}

      {panel ? (
        <div className={clsx('space-y-3 rounded-lg border p-4', panel.decision === 'approve' ? 'border-gain/40 bg-gain/5' : 'border-loss/40 bg-loss/5')}>
          <p className="text-sm font-medium">
            {panel.decision === 'approve' ? 'Approve' : 'Reject'} {panel.ids.length === 1 ? panelEmails[0] : `${panel.ids.length} accounts`}
          </p>
          {panel.ids.length > 1 ? <p className="text-xs text-fg-muted">{panelEmails.join(', ')}</p> : null}
          <div className="flex flex-wrap gap-1.5">
            {QUICK_NOTES[panel.decision].map((q) => (
              <button key={q} type="button" onClick={() => setNote(q)} className="rounded-full border border-line px-2.5 py-1 text-xs text-fg-muted hover:border-accent/60 hover:text-fg">
                {q}
              </button>
            ))}
          </div>
          <label htmlFor="decision-note" className="sr-only">
            Documented note
          </label>
          <Textarea
            id="decision-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={panel.decision === 'approve' ? 'Why is this account approved? (min 10 characters, kept in the audit log)' : 'Reason shown to the applicant (min 10 characters)'}
            className="h-20 text-sm"
            autoFocus
          />
          {result?.failed.length ? (
            <Notice tone="danger">
              {result.failed.map((f) => (
                <div key={f.email}>
                  {f.email}: {f.error}
                </div>
              ))}
            </Notice>
          ) : null}
          <div className="flex gap-2">
            <Button variant={panel.decision === 'approve' ? 'primary' : 'danger'} className="h-9 px-4 text-sm" disabled={busy || note.trim().length < 10} onClick={submit}>
              {busy ? 'Saving…' : `Confirm ${panel.decision === 'approve' ? 'approval' : 'rejection'}`}
            </Button>
            <Button variant="ghost" className="h-9 px-4 text-sm" disabled={busy} onClick={() => setPanel(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {visible.length === 0 ? (
        <EmptyState title={tab === 'pending' ? 'No sign-ups waiting' : tab === 'rejected' ? 'No rejected sign-ups' : 'No decisions in the last 30 days'}>
          {tab === 'pending' ? 'New registrations appear here after the applicant signs up.' : null}
        </EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-fg-muted">
                {selectable ? (
                  <th className="w-8 py-2 pr-2">
                    <input
                      type="checkbox"
                      aria-label="Select all"
                      checked={allSelected}
                      onChange={() => setSelected(allSelected ? new Set() : new Set(visible.map((r) => r.userId)))}
                    />
                  </th>
                ) : null}
                <th className="py-2 pr-4 font-medium">Applicant</th>
                {!compact ? <th className="py-2 pr-4 font-medium">Contact</th> : null}
                <th className="py-2 pr-4 font-medium">Signed up</th>
                {tab !== 'pending' ? <th className="py-2 pr-4 font-medium">Decision</th> : null}
                {canDecide ? <th className="py-2 text-right font-medium">Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.userId} className={clsx('border-b border-line/60 last:border-0', selected.has(r.userId) && 'bg-accent/5')}>
                  {selectable ? (
                    <td className="py-2.5 pr-2">
                      <input type="checkbox" aria-label={`Select ${r.email}`} checked={selected.has(r.userId)} onChange={() => toggle(r.userId)} />
                    </td>
                  ) : null}
                  <td className="py-2.5 pr-4">
                    <Link href={`/admin/users/${r.userId}`} className="font-medium text-accent hover:underline">
                      {r.fullName ?? r.email}
                    </Link>
                    <div className="text-xs text-fg-muted">
                      {r.username ? <>@{r.username} · </> : null}
                      <Mono>{r.memberCode}</Mono>
                      {r.referredBy ? <> · referred by <Mono>{r.referredBy}</Mono></> : null}
                    </div>
                  </td>
                  {!compact ? (
                    <td className="py-2.5 pr-4 text-xs text-fg-muted">
                      <div>{r.email}</div>
                      <div>
                        {r.phone ?? '—'}
                        {r.country ? <> · {r.country}</> : null}
                      </div>
                    </td>
                  ) : null}
                  <td className="whitespace-nowrap py-2.5 pr-4 text-fg-muted" title={new Date(r.createdAt).toLocaleString()}>
                    {ago(r.createdAt)}
                  </td>
                  {tab !== 'pending' ? (
                    <td className="py-2.5 pr-4 text-xs">
                      <Badge tone={r.status === 'rejected' ? 'danger' : r.status === 'active' ? 'success' : 'warn'}>{r.status === 'active' ? 'approved' : r.status.replace('_', ' ')}</Badge>
                      <div className="mt-1 text-fg-muted">
                        {r.reviewedBy ?? 'staff'} · {r.reviewedAt ? ago(r.reviewedAt) : ''}
                      </div>
                      {r.reason ? <div className="mt-0.5 max-w-xs text-fg-muted">“{r.reason}”</div> : null}
                    </td>
                  ) : null}
                  {canDecide ? (
                    <td className="whitespace-nowrap py-2.5 text-right">
                      {r.status === 'pending_approval' || r.status === 'rejected' ? (
                        <span className="inline-flex gap-1.5">
                          <Button className="h-8 px-3 text-xs" disabled={busy} onClick={() => open('approve', [r.userId])}>
                            Approve
                          </Button>
                          {r.status === 'pending_approval' ? (
                            <Button variant="secondary" className="h-8 px-3 text-xs" disabled={busy} onClick={() => open('reject', [r.userId])}>
                              Reject
                            </Button>
                          ) : null}
                        </span>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {compact && counts.pending > visible.length ? (
        <Link href="/admin/approvals" className="block text-xs text-accent hover:underline">
          View all {counts.pending} waiting →
        </Link>
      ) : null}
    </div>
  );
}
