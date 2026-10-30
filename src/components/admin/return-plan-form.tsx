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
  const [autoEnroll, setAutoEnroll] = useState(true);
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
      autoEnroll,
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
      <label className="flex items-start gap-2 text-sm sm:col-span-2">
        <input type="checkbox" className="mt-1" checked={autoEnroll} onChange={(e) => setAutoEnroll(e.target.checked)} />
        <span>
          Enrol every member deposit automatically, existing and new (on the platform and recorded offline). Deposits move from available balance into plan principal and earn from the day after
          they were received (never before the plan is activated).
        </span>
      </label>
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

/** Register a company wallet whose transfers to the group wallet fund members' daily returns. */
export function FundingWalletForm({ networks }: { networks: { id: number; label: string }[] }) {
  const router = useRouter();
  const [networkId, setNetworkId] = useState(String(networks[0]?.id ?? ''));
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const valid = /^0x[0-9a-fA-F]{40}$/.test(address.trim()) && label.trim().length >= 3;

  async function submit() {
    if (!window.confirm('Register this wallet? Every transfer from it to the group wallet will be recorded as company funding for daily returns. Never register a member’s wallet.')) return;
    setBusy(true);
    setMsg(null);
    const r = await apiPost('/api/admin/returns/funding-wallets', { networkId: Number(networkId), address: address.trim(), label });
    setBusy(false);
    setMsg(r.ok ? { ok: true, text: 'Registered. Its transfers are recorded automatically.' } : { ok: false, text: r.error ?? 'Failed' });
    if (r.ok) {
      setAddress('');
      setLabel('');
      router.refresh();
    }
  }

  return (
    <div className="grid gap-3 sm:grid-cols-[160px_1fr_200px_auto] sm:items-end">
      <Field label="Network" htmlFor="fund-network">
        <Select id="fund-network" value={networkId} onChange={(e) => setNetworkId(e.target.value)}>
          {networks.map((n) => (
            <option key={n.id} value={n.id}>
              {n.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Sending wallet address" htmlFor="fund-address">
        <Input id="fund-address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="0x…" spellCheck={false} className="font-mono text-xs" />
      </Field>
      <Field label="Label" htmlFor="fund-label">
        <Input id="fund-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Finance team wallet" maxLength={80} />
      </Field>
      <Button className="h-9 px-4 text-sm" disabled={busy || !valid} onClick={submit}>
        {busy ? '…' : 'Register'}
      </Button>
      {msg ? (
        <div className="sm:col-span-4">
          <Notice tone={msg.ok ? 'success' : 'danger'}>{msg.text}</Notice>
        </div>
      ) : null}
    </div>
  );
}

/** Record principal a member handed the team offline and open a plan for them. */
export function OfflineSubscriptionForm({ members, plans }: { members: { userId: string; label: string }[]; plans: { id: string; label: string }[] }) {
  const router = useRouter();
  const [f, setF] = useState({ userId: members[0]?.userId ?? '', planId: plans[0]?.id ?? '', amount: '', reference: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  async function submit() {
    if (!window.confirm(`Record ${f.amount} received offline and open the plan for this member? Daily returns start accruing tomorrow.`)) return;
    setBusy(true);
    setMsg(null);
    const r = await apiPost('/api/admin/returns/offline/subscriptions', f);
    setBusy(false);
    setMsg(r.ok ? { ok: true, text: 'Recorded. The plan opens within a few minutes.' } : { ok: false, text: r.error ?? 'Failed' });
    if (r.ok) {
      setF((s) => ({ ...s, amount: '', reference: '' }));
      router.refresh();
    }
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Member" htmlFor="off-member">
        <Select id="off-member" value={f.userId} onChange={set('userId')}>
          {members.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Plan" htmlFor="off-plan">
        <Select id="off-plan" value={f.planId} onChange={set('planId')}>
          {plans.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Principal received offline" htmlFor="off-amount">
        <Input id="off-amount" value={f.amount} onChange={set('amount')} inputMode="decimal" />
      </Field>
      <Field label="Reference" htmlFor="off-ref" hint="Who received it, when and how">
        <Input id="off-ref" value={f.reference} onChange={set('reference')} maxLength={500} />
      </Field>
      <div className="sm:col-span-2">
        <Button className="h-9 px-4 text-sm" disabled={busy || !f.userId || !f.planId || !f.amount || f.reference.trim().length < 5} onClick={submit}>
          {busy ? '…' : 'Record offline principal'}
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

/** Record that the team paid a member's due returns offline, up to and including a day. */
export function OfflinePaymentForm({ userId, tokenId, defaultDate }: { userId: string; tokenId: number; defaultDate: string }) {
  const router = useRouter();
  const [date, setDate] = useState(defaultDate);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Input aria-label="Paid through" type="date" value={date} max={defaultDate} onChange={(e) => setDate(e.target.value)} className="h-8 w-40 text-xs" />
        <Input aria-label="Note" placeholder="Who paid, how (min 10 characters)" value={note} onChange={(e) => setNote(e.target.value)} className="h-8 min-w-48 flex-1 text-xs" />
        <Button
          variant="secondary"
          className="h-8 px-3 text-xs"
          disabled={busy || !date || note.trim().length < 10}
          onClick={async () => {
            if (!window.confirm(`Mark this member's due returns up to ${date} as paid offline?`)) return;
            setBusy(true);
            setMsg(null);
            const r = await apiPost('/api/admin/returns/offline/payments', { userId, tokenId, throughDate: date, note });
            setBusy(false);
            setMsg(r.ok ? { ok: true, text: 'Recorded.' } : { ok: false, text: r.error ?? 'Failed' });
            if (r.ok) {
              setNote('');
              router.refresh();
            }
          }}
        >
          {busy ? '…' : 'Mark paid offline'}
        </Button>
      </div>
      {msg ? <p className={msg.ok ? 'text-xs text-gain' : 'text-xs text-loss'}>{msg.text}</p> : null}
    </div>
  );
}
