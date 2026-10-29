'use client';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { apiPost } from '@/lib/api-client';
import { formatUnits } from '@/lib/money';
import { Button, Field, Input, Notice, Select, Textarea } from '@/components/ui/primitives';

type Msg = { ok: boolean; text: string } | null;

/** Shared submit plumbing: busy state, message, refresh on success. */
function useSubmit() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  async function run(url: string, payload: unknown, ok: string, opts: { idempotencyKey?: string } = {}): Promise<boolean> {
    setBusy(true);
    setMsg(null);
    const r = await apiPost(url, payload, opts);
    setBusy(false);
    setMsg(r.ok ? { ok: true, text: ok } : { ok: false, text: r.error ?? 'Failed' });
    if (r.ok) router.refresh();
    return r.ok;
  }
  const notice: ReactNode = msg ? <Notice tone={msg.ok ? 'success' : 'danger'}>{msg.text}</Notice> : null;
  return { busy, run, notice };
}

export function EditHolderForm({ holderId, name: initialName, note: initialNote }: { holderId: string; name: string; note: string | null }) {
  const [name, setName] = useState(initialName);
  const [note, setNote] = useState(initialNote ?? '');
  const { busy, run, notice } = useSubmit();
  return (
    <div className="space-y-3">
      <Field label="Name" htmlFor="edit-name">
        <Input id="edit-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
      </Field>
      <Field label="Private note" htmlFor="edit-note">
        <Input id="edit-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      </Field>
      <Button className="h-8 px-3 text-xs" variant="secondary" disabled={busy || name.trim().length < 2} onClick={() => run(`/api/admin/offchain/holders/${holderId}`, { name, note: note || null }, 'Saved.')}>
        {busy ? '…' : 'Save details'}
      </Button>
      {notice}
    </div>
  );
}

const KINDS = [
  { value: 'contribution', label: 'Money received from them', hint: 'Adds to their balance' },
  { value: 'earnings', label: 'Earnings / interest', hint: 'Adds to their balance; say how it was earned' },
  { value: 'payback', label: 'Paid back to them', hint: 'Subtracts from their balance' },
  { value: 'adjustment', label: 'Adjustment (+ or -)', hint: 'Use a minus sign to subtract' },
] as const;

/**
 * Add an entry. The idempotency key is fixed for this form until a submit
 * succeeds, so a double click or a retry after a network error records it once.
 */
export function EntryForm({ holderId }: { holderId: string }) {
  const [kind, setKind] = useState<(typeof KINDS)[number]['value']>('contribution');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState('');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const { busy, run, notice } = useSubmit();
  const label = KINDS.find((k) => k.value === kind)!;
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Type" htmlFor="entry-kind" hint={label.hint}>
          <Select id="entry-kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Amount (USDT)" htmlFor="entry-amount">
          <Input id="entry-amount" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="100.00" />
        </Field>
        <Field label="Date" htmlFor="entry-date">
          <Input id="entry-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </div>
      <Field label="Reason (shown to the member if linked)" htmlFor="entry-reason">
        <Textarea id="entry-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
      </Field>
      <Button
        className="h-8 px-3 text-xs"
        disabled={busy || !amount.trim() || reason.trim().length < 10 || !date}
        onClick={async () => {
          if (!window.confirm(`Record "${label.label}" of ${amount} USDT? Entries can't be edited later, only reversed.`)) return;
          if (await run(`/api/admin/offchain/holders/${holderId}/entries`, { kind, amount, occurredOn: date, reason }, 'Recorded.', { idempotencyKey: key })) {
            setAmount('');
            setReason('');
            setKey(crypto.randomUUID());
          }
        }}
      >
        {busy ? '…' : 'Record entry'}
      </Button>
      {notice}
    </div>
  );
}

export function LinkHolderForm({ holderId }: { holderId: string }) {
  const [code, setCode] = useState('');
  const { busy, run, notice } = useSubmit();
  return (
    <div className="space-y-3">
      <Field label="Their member id" htmlFor="link-code" hint="Linking is permanent. They will then see this balance and its history.">
        <Input id="link-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="EW-000123" autoCapitalize="characters" maxLength={12} />
      </Field>
      <Button
        className="h-8 px-3 text-xs"
        variant="secondary"
        disabled={busy || !/^EW-[0-9]{6,}$/i.test(code.trim())}
        onClick={() => window.confirm(`Link this record to ${code.trim().toUpperCase()}? This cannot be undone.`) && run(`/api/admin/offchain/holders/${holderId}/link`, { memberCode: code }, 'Linked.')}
      >
        {busy ? '…' : 'Link account'}
      </Button>
      {notice}
    </div>
  );
}

export interface AssignmentOption {
  id: string;
  amountBase: string;
  decimals: number;
  symbol: string;
  postedAt: string;
}

/** Match a group-wallet receipt already assigned to the member, reducing the off-platform balance by its amount. */
export function MoveToPlatformForm({ holderId, assignments }: { holderId: string; assignments: AssignmentOption[] }) {
  const [allocationId, setAllocationId] = useState(assignments[0]?.id ?? '');
  const [reason, setReason] = useState('');
  const { busy, run, notice } = useSubmit();
  if (!assignments.length) {
    return (
      <Notice tone="info">
        Send their money to the group wallet, then assign that receipt to their account on the Trading &amp; allocation page. It appears here to match.
      </Notice>
    );
  }
  return (
    <div className="space-y-3">
      <Field label="Assigned receipt" htmlFor="move-alloc">
        <Select id="move-alloc" value={allocationId} onChange={(e) => setAllocationId(e.target.value)}>
          {assignments.map((a) => (
            <option key={a.id} value={a.id}>
              {formatUnits(BigInt(a.amountBase), a.decimals, { maxFraction: 6 })} {a.symbol} · {a.postedAt.slice(0, 10)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Reason" htmlFor="move-reason">
        <Textarea id="move-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
      </Field>
      <Button className="h-8 px-3 text-xs" disabled={busy || !allocationId || reason.trim().length < 10} onClick={() => run(`/api/admin/offchain/holders/${holderId}/move`, { allocationId, reason }, 'Matched.')}>
        {busy ? '…' : 'Move to platform'}
      </Button>
      {notice}
    </div>
  );
}

