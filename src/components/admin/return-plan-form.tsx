'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPost } from '@/lib/api-client';
import { Button, Field, Input, Notice, Select } from '@/components/ui/primitives';

/**
 * Draft a daily-return plan. Every term is entered from the approved written
 * terms; nothing is defaulted. A different administrator activates it.
 */
export function ReturnPlanForm({ tokens }: { tokens: { id: number; label: string }[] }) {
  const router = useRouter();
  const [f, setF] = useState({ name: '', tokenId: String(tokens[0]?.id ?? ''), rate: '', min: '', term: '', payableAfter: '', lock: '', terms: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  const int = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN);
  const ready = f.name.trim().length >= 3 && f.rate && f.min && f.payableAfter !== '' && f.lock !== '' && f.terms.trim().length >= 5;

  async function submit() {
    if (!window.confirm('Create this plan as a draft? Its terms cannot be edited afterwards; a change needs a new plan.')) return;
    setBusy(true);
    setMsg(null);
    const r = await apiPost('/api/admin/returns/plans', {
      name: f.name,
      tokenId: Number(f.tokenId),
      dailyRatePercent: f.rate,
      minPrincipal: f.min,
      termDays: f.term.trim() === '' ? null : int(f.term),
      payableAfterDays: int(f.payableAfter),
      principalLockDays: int(f.lock),
      termsReference: f.terms,
    });
    setBusy(false);
    setMsg(r.ok ? { ok: true, text: 'Draft created. Another administrator must activate it.' } : { ok: false, text: r.error ?? 'Failed' });
    if (r.ok) router.refresh();
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Plan name" htmlFor="plan-name">
        <Input id="plan-name" value={f.name} onChange={set('name')} maxLength={80} />
      </Field>
      <Field label="Token" htmlFor="plan-token">
        <Select id="plan-token" value={f.tokenId} onChange={set('tokenId')}>
          {tokens.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Daily rate (% of principal)" htmlFor="plan-rate" hint="e.g. 0.33">
        <Input id="plan-rate" value={f.rate} onChange={set('rate')} inputMode="decimal" />
      </Field>
      <Field label="Minimum principal" htmlFor="plan-min">
        <Input id="plan-min" value={f.min} onChange={set('min')} inputMode="decimal" />
      </Field>
      <Field label="Term (days)" htmlFor="plan-term" hint="Leave empty for no fixed term">
        <Input id="plan-term" value={f.term} onChange={set('term')} inputMode="numeric" />
      </Field>
      <Field label="Payable after (days)" htmlFor="plan-payable" hint="0 = due the day after it is earned">
        <Input id="plan-payable" value={f.payableAfter} onChange={set('payableAfter')} inputMode="numeric" />
      </Field>
      <Field label="Principal lock (days)" htmlFor="plan-lock" hint="Principal can be requested back after this">
        <Input id="plan-lock" value={f.lock} onChange={set('lock')} inputMode="numeric" />
      </Field>
      <Field label="Approved terms reference" htmlFor="plan-terms" hint="Document id or link of the signed terms">
        <Input id="plan-terms" value={f.terms} onChange={set('terms')} maxLength={500} />
      </Field>
      <div className="sm:col-span-2">
        <Button className="h-9 px-4 text-sm" disabled={busy || !ready} onClick={submit}>
          {busy ? '…' : 'Create draft plan'}
        </Button>
      </div>
      {msg ? (
        <div className="sm:col-span-2">
          <Notice tone={msg.ok ? 'success' : 'danger'}>{msg.text}</Notice>
        </div>
      ) : null}
    </div>
  );
}
