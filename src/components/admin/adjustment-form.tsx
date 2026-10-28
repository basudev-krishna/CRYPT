'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPost } from '@/lib/api-client';
import { Button, Field, Input, Notice, Select, Textarea } from '@/components/ui/primitives';

type Fund = 'operator_float' | 'referral_reward_fund';

export interface FloatOption {
  fund: Fund;
  tokenId: number;
  symbol: string;
  balance: string; // formatted
}

const FUNDS: Record<Fund, string> = { operator_float: 'Balance (operator float)', referral_reward_fund: 'Income (referral fund)' };

/**
 * Credit or debit a member against the operator float, or award / correct
 * income against the referral fund. Posted by the worker within seconds.
 */
export function AdjustmentForm({ userId, floats }: { userId: string; floats: FloatOption[] }) {
  const router = useRouter();
  const [fund, setFund] = useState<Fund>(floats[0]?.fund ?? 'operator_float');
  const options = floats.filter((f) => f.fund === fund);
  const [tokenId, setTokenId] = useState(options[0]?.tokenId ?? 0);
  const [direction, setDirection] = useState<'credit' | 'debit'>('credit');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (!floats.length) {
    return (
      <Notice tone="info">
        No operator float yet. Send your own USDT to the group wallet, then allocate that receipt as an operator float (or referral fund) top-up on the Trading
        &amp; allocation page.
      </Notice>
    );
  }
  const funds = [...new Set(floats.map((f) => f.fund))];
  const effectiveDirection = direction;
  const symbol = options.find((f) => f.tokenId === tokenId)?.symbol ?? '';
  async function submit() {
    const text =
      effectiveDirection === 'credit'
        ? `Credit ${amount} ${symbol} to this member from the ${FUNDS[fund].toLowerCase()}?`
        : fund === 'referral_reward_fund'
          ? `Take ${amount} ${symbol} of income back from this member into the referral fund?`
          : `Debit ${amount} ${symbol} from this member into your float?`;
    if (!window.confirm(text)) return;
    setBusy(true);
    setMsg(null);
    const r = await apiPost(`/api/admin/users/${userId}/adjustments`, { tokenId, direction: effectiveDirection, fund, amount, reason });
    setBusy(false);
    setMsg(r.ok ? { ok: true, text: 'Recorded. It posts within a few seconds.' } : { ok: false, text: r.error ?? 'Failed' });
    if (r.ok) {
      setAmount('');
      setReason('');
      router.refresh();
    }
  }
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Source" htmlFor="adj-fund">
          <Select
            id="adj-fund"
            value={fund}
            onChange={(e) => {
              const f = e.target.value as Fund;
              setFund(f);
              setTokenId(floats.find((o) => o.fund === f)?.tokenId ?? 0);
            }}
          >
            {funds.map((f) => (
              <option key={f} value={f}>
                {FUNDS[f]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Direction" htmlFor="adj-direction" hint={
            fund === 'referral_reward_fund'
              ? direction === 'credit'
                ? 'A bonus or income they are owed'
                : 'Income paid by mistake, returned to the fund'
              : direction === 'credit'
                ? 'They paid you personally'
                : 'You paid them personally'
          }>
          <Select id="adj-direction" value={effectiveDirection} onChange={(e) => setDirection(e.target.value as 'credit' | 'debit')}>
            <option value="credit">Credit (add to balance)</option>
            <option value="debit">Debit (take from balance)</option>
          </Select>
        </Field>
        <Field label="Token" htmlFor="adj-token">
          <Select id="adj-token" value={tokenId} onChange={(e) => setTokenId(Number(e.target.value))}>
            {options.map((f) => (
              <option key={f.tokenId} value={f.tokenId}>
                {f.symbol} (available {f.balance})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Amount" htmlFor="adj-amount">
          <Input id="adj-amount" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="100.00" />
        </Field>
      </div>
      <Field label="Reason (shown to the member)" htmlFor="adj-reason">
        <Textarea id="adj-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
      </Field>
      <Button className="h-8 px-3 text-xs" disabled={busy || !amount.trim() || reason.trim().length < 10} onClick={submit}>
        {busy ? '…' : fund === 'referral_reward_fund' ? (effectiveDirection === 'credit' ? 'Award income' : 'Correct income') : effectiveDirection === 'credit' ? 'Credit member' : 'Debit member'}
      </Button>
      {msg ? <Notice tone={msg.ok ? 'success' : 'danger'}>{msg.text}</Notice> : null}
    </div>
  );
}
