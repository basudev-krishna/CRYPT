'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPost } from '@/lib/api-client';
import { formatUnits, parseUnits } from '@/lib/money';
import { Button, Field, Input, Notice, Select, Textarea } from '@/components/ui/primitives';

export interface MemberOption {
  userId: string;
  label: string;
}

/**
 * Allocate an unattributed group-wallet receipt: to one member (assignment) or
 * split across several (distribution). Amounts must add up exactly to the
 * receipt; the server checks this again.
 */
export function AllocationForm({ depositId, amountBase, decimals, members }: { depositId: string; amountBase: string; decimals: number; members: MemberOption[] }) {
  const router = useRouter();
  const total = formatUnits(BigInt(amountBase), decimals);
  const [kind, setKind] = useState<'assignment' | 'distribution'>('assignment');
  const [lines, setLines] = useState([{ userId: members[0]?.userId ?? '', amount: total }]);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  let sum: bigint | null = 0n;
  try {
    for (const l of lines) sum += parseUnits(l.amount || '0', decimals);
  } catch {
    sum = null;
  }
  const remaining = sum === null ? null : BigInt(amountBase) - sum;

  const setLine = (i: number, patch: Partial<{ userId: string; amount: string }>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  async function submit() {
    if (!window.confirm(kind === 'assignment' ? 'Credit this deposit to the selected member?' : `Distribute ${total} across ${lines.length} members?`)) return;
    setBusy(true);
    setMsg(null);
    const r = await apiPost('/api/admin/allocations', { depositId, kind, reason, lines });
    setBusy(false);
    if (!r.ok) setMsg({ ok: false, text: r.error ?? 'Failed' });
    else {
      setMsg({ ok: true, text: 'Recorded. It posts within a few seconds.' });
      router.refresh();
    }
  }

  return (
    <div className="space-y-2">
      <Select
        aria-label="Allocation type"
        value={kind}
        onChange={(e) => {
          const k = e.target.value as 'assignment' | 'distribution';
          setKind(k);
          if (k === 'assignment') setLines((ls) => [{ userId: ls[0]?.userId ?? '', amount: total }]);
        }}
      >
        <option value="assignment">Assign to one member</option>
        <option value="distribution">Distribute across members</option>
      </Select>
      {lines.map((l, i) => (
        <div key={i} className="flex gap-2">
          <Select aria-label="Member" value={l.userId} onChange={(e) => setLine(i, { userId: e.target.value })} className="min-w-0 flex-1">
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.label}
              </option>
            ))}
          </Select>
          <Input aria-label="Amount" value={l.amount} onChange={(e) => setLine(i, { amount: e.target.value })} inputMode="decimal" className="w-28" readOnly={kind === 'assignment'} />
          {kind === 'distribution' && lines.length > 1 ? (
            <Button variant="ghost" className="h-9 px-2 text-xs" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label="Remove line">
              ✕
            </Button>
          ) : null}
        </div>
      ))}
      {kind === 'distribution' ? (
        <div className="flex items-center justify-between text-xs">
          <Button variant="secondary" className="h-8 px-3 text-xs" onClick={() => setLines((ls) => [...ls, { userId: members[0]?.userId ?? '', amount: '0' }])}>
            Add member
          </Button>
          <span className={remaining === 0n ? 'text-gain' : 'text-loss'}>
            {remaining === null ? 'Invalid amount' : remaining === 0n ? 'Adds up exactly' : `Remaining: ${formatUnits(remaining, decimals)}`}
          </span>
        </div>
      ) : null}
      <Field label="Reason (shown to the member)" htmlFor={`reason-${depositId}`}>
        <Textarea id={`reason-${depositId}`} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
      </Field>
      <Button className="h-8 px-3 text-xs" disabled={busy || reason.trim().length < 10 || remaining !== 0n || members.length === 0} onClick={submit}>
        {busy ? '…' : kind === 'assignment' ? 'Assign' : 'Distribute'}
      </Button>
      {msg ? <Notice tone={msg.ok ? 'success' : 'danger'}>{msg.text}</Notice> : null}
    </div>
  );
}

/** Record the hash of a payout sent from the group wallet, or decline to send it. */
export function ManualPayoutForm({ withdrawalId }: { withdrawalId: string }) {
  const router = useRouter();
  const [txHash, setTxHash] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function send(action: 'record' | 'cancel') {
    if (action === 'cancel' && !window.confirm('Decline this payout? The member’s funds are released back to their balance.')) return;
    setBusy(true);
    setMsg(null);
    const r = await apiPost(`/api/admin/withdrawals/${withdrawalId}/manual-payout`, action === 'record' ? { action, txHash, note } : { action, note });
    setBusy(false);
    if (!r.ok) setMsg({ ok: false, text: r.error ?? 'Failed' });
    else {
      setMsg({ ok: true, text: action === 'record' ? 'Verified on chain. It settles once confirmed.' : 'Declined.' });
      router.refresh();
    }
  }

  return (
    <div className="space-y-2">
      <Input aria-label="Transaction hash" value={txHash} onChange={(e) => setTxHash(e.target.value)} placeholder="0x… tx hash after it is mined" spellCheck={false} className="font-mono text-xs" />
      <Textarea aria-label="Note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Note (at least 10 characters)" />
      <div className="flex gap-2">
        <Button className="h-8 px-3 text-xs" disabled={busy || note.trim().length < 10 || !/^0x[0-9a-fA-F]{64}$/.test(txHash.trim())} onClick={() => send('record')}>
          Record payout
        </Button>
        <Button variant="danger" className="h-8 px-3 text-xs" disabled={busy || note.trim().length < 10} onClick={() => send('cancel')}>
          Decline
        </Button>
      </div>
      {msg ? <Notice tone={msg.ok ? 'success' : 'danger'}>{msg.text}</Notice> : null}
    </div>
  );
}
