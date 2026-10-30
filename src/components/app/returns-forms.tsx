'use client';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { apiPost, newIdempotencyKey } from '@/lib/api-client';
import { Button, Field, Input } from '@/components/ui/primitives';

/** Commit available balance to a daily-return plan. The worker opens it within a few minutes. */
export function SubscribePlanForm({ planId, symbol, minDisplay, availableDisplay }: { planId: string; symbol: string; minDisplay: string; availableDisplay: string }) {
  const router = useRouter();
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const key = useRef(newIdempotencyKey());
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!window.confirm(`Commit ${amount} ${symbol} to this plan? Your principal is locked for the plan's lock period. Returns are paid only from company revenue.`)) return;
        setBusy(true);
        const r = await apiPost('/api/returns/subscribe', { planId, amount: amount.trim() }, { idempotencyKey: key.current });
        setBusy(false);
        setMsg(r.ok ? { ok: true, text: 'Requested. Your principal moves into the plan within a few minutes.' } : { ok: false, text: r.error ?? 'Failed' });
        if (r.ok) {
          key.current = newIdempotencyKey();
          setAmount('');
          router.refresh();
        }
      }}
    >
      <Field label={`Amount (${symbol})`} htmlFor={`plan-amount-${planId}`} hint={`Minimum ${minDisplay} · Available ${availableDisplay}`}>
        <Input id={`plan-amount-${planId}`} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" className="w-44" />
      </Field>
      <Button type="submit" variant="secondary" disabled={!amount || busy}>
        {busy ? '…' : 'Subscribe'}
      </Button>
      {msg ? <p className={msg.ok ? 'w-full text-xs text-gain' : 'w-full text-xs text-loss'}>{msg.text}</p> : null}
    </form>
  );
}
