'use client';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
import { apiPost, newIdempotencyKey } from '@/lib/api-client';
import { AmountError, parseUnits } from '@/lib/money';
import { Button, Card, CardHeader, Field, Input, Notice, Select } from '@/components/ui/primitives';
import { fmt } from '@/components/ui/money';
import { MfaChallengeForm } from './auth-forms';

interface Props {
  networks: { id: number; name: string; symbol: string; decimals: number }[];
  availableBase: string;
  feeBase: string;
  minBase: string;
  mfaEnrolled: boolean;
  blockedReason: string | null;
}

type Step = { kind: 'form' } | { kind: 'confirm'; id: string; amount: bigint; fee: bigint; net: bigint; destination: string } | { kind: 'done'; status: string };

export function WithdrawForm({ networks, availableBase, feeBase, minBase, mfaEnrolled, blockedReason }: Props) {
  const router = useRouter();
  const [networkId, setNetworkId] = useState(networks[0]?.id ?? 0);
  const net = networks.find((n) => n.id === networkId) ?? networks[0];
  const decimals = net?.decimals ?? 6;
  const [destination, setDestination] = useState('');
  const [amount, setAmount] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'form' });
  const [error, setError] = useState<{ message: string; code?: string; checks?: { name: string; result: string }[] } | null>(null);
  const [needMfa, setNeedMfa] = useState(false);
  const [busy, setBusy] = useState(false);
  // One key per intended withdrawal: retries (double-click, network retry) reuse it.
  const keyRef = useRef(newIdempotencyKey());

  const available = BigInt(availableBase);
  const fee = BigInt(feeBase);
  const parsed = useMemo(() => {
    if (!amount) return null;
    try {
      return parseUnits(amount, decimals);
    } catch (e) {
      return e instanceof AmountError ? e : null;
    }
  }, [amount, decimals]);
  const amountError =
    parsed instanceof AmountError
      ? parsed.message
      : typeof parsed === 'bigint' && parsed > available
        ? 'Exceeds your available balance'
        : typeof parsed === 'bigint' && parsed < BigInt(minBase)
          ? `Minimum withdrawal is ${fmt(minBase, decimals)}`
          : null;

  if (blockedReason) return <Notice tone="warn" title="Withdrawals unavailable">{blockedReason}</Notice>;

  async function submit() {
    setBusy(true);
    setError(null);
    const r = await apiPost<{ id: string; fee: string; net: string; status: string }>(
      '/api/withdrawals',
      { networkId, destination: destination.trim(), amount: amount.trim() },
      { idempotencyKey: keyRef.current },
    );
    setBusy(false);
    if (!r.ok || !r.data) return setError({ message: r.error ?? 'Request failed', code: r.code, checks: r.details as never });
    setStep({ kind: 'confirm', id: r.data.id, amount: parseUnits(amount.trim(), decimals), fee: BigInt(r.data.fee), net: BigInt(r.data.net), destination: destination.trim() });
  }

  async function confirm(id: string) {
    setBusy(true);
    setError(null);
    const r = await apiPost<{ status: string }>('/api/withdrawals/confirm', { withdrawalId: id });
    setBusy(false);
    if (r.ok && r.data) {
      setStep({ kind: 'done', status: r.data.status });
      keyRef.current = newIdempotencyKey();
      router.refresh();
      return;
    }
    if (r.code === 'mfa_required') return setNeedMfa(true);
    setError({ message: r.error ?? 'Confirmation failed', code: r.code });
  }

  if (step.kind === 'done') {
    return (
      <Notice tone="success" title="Withdrawal confirmed and funds reserved">
        Your request passed the initial checks and the amount is reserved. Automated risk, compliance and liquidity checks run next; you can follow the status
        below. Funds are only marked as sent after the transaction is confirmed on chain.
        <div className="mt-3">
          <Button variant="secondary" onClick={() => setStep({ kind: 'form' })}>New withdrawal</Button>
        </div>
      </Notice>
    );
  }

  if (step.kind === 'confirm') {
    return (
      <Card>
        <CardHeader title="Confirm withdrawal" subtitle="Check every detail. On-chain transfers cannot be reversed." />
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <Row label="Network" value={net?.name} />
          <Row label="Destination" value={<code className="break-all font-mono text-xs">{step.destination}</code>} />
          <Row label="Amount debited" value={`${fmt(step.amount, decimals, decimals)} ${net?.symbol}`} />
          <Row label="Platform fee" value={`${fmt(step.fee, decimals, decimals)} ${net?.symbol}`} />
          <Row label="You receive" value={<strong className="num">{`${fmt(step.net, decimals, decimals)} ${net?.symbol}`}</strong>} />
        </dl>
        {needMfa ? (
          <div className="mt-5 rounded-lg border border-line p-4">
            {mfaEnrolled ? (
              <>
                <p className="mb-3 text-sm text-fg-muted">Enter your authenticator code to authorise this withdrawal.</p>
                <MfaChallengeForm
                  onDone={() => {
                    setNeedMfa(false);
                    void confirm(step.id);
                  }}
                />
              </>
            ) : (
              <Notice tone="warn" title="Two-factor authentication required">
                Withdrawals require an authenticator app. <a href="/settings/security" className="text-accent hover:underline">Set it up →</a>
              </Notice>
            )}
          </div>
        ) : null}
        {error ? (
          <div className="mt-4">
            <Notice tone="danger">{error.message}</Notice>
          </div>
        ) : null}
        <div className="mt-5 flex gap-3">
          <Button onClick={() => confirm(step.id)} disabled={busy || needMfa}>
            {busy ? 'Confirming…' : 'Confirm withdrawal'}
          </Button>
          <Button variant="ghost" onClick={() => setStep({ kind: 'form' })} disabled={busy}>
            Back
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader title="Withdrawal request" subtitle="Only your available (uninvested) balance can be withdrawn. Redeem investment units first to free up funds." />
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!amountError && typeof parsed === 'bigint') void submit();
        }}
      >
        <Field label="Network" htmlFor="wd-network" hint="Send only to an address on this network.">
          <Select id="wd-network" value={networkId} onChange={(e) => setNetworkId(Number(e.target.value))}>
            {networks.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name} · {n.symbol}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Destination address" htmlFor="wd-dest" hint="New addresses have a short security cooldown before the first payout.">
          <Input id="wd-dest" value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="0x…" autoComplete="off" spellCheck={false} required />
        </Field>
        <Field label={`Amount (${net?.symbol ?? ''})`} htmlFor="wd-amount" error={amount ? amountError : null} hint={`Available: ${fmt(available, decimals, decimals)} · Fee: ${fmt(fee, decimals)}`}>
          <div className="flex gap-2">
            <Input id="wd-amount" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" aria-invalid={Boolean(amount && amountError)} required />
            <Button type="button" variant="secondary" onClick={() => setAmount(fmt(available, decimals, decimals).replace(/,/g, ''))}>
              Max
            </Button>
          </div>
        </Field>
        {typeof parsed === 'bigint' && !amountError && parsed > fee ? (
          <p className="text-sm text-fg-muted">
            You will receive <span className="num text-fg">{fmt(parsed - fee, decimals, decimals)}</span> {net?.symbol} after the {fmt(fee, decimals)} fee.
          </p>
        ) : null}
        {error ? (
          <Notice tone="danger" title="Request not accepted">
            {error.message}
            {error.checks?.length ? (
              <ul className="mt-2 list-disc pl-5 text-xs">
                {error.checks.filter((c) => c.result !== 'pass').map((c) => (
                  <li key={c.name}>{c.name.replace(/_/g, ' ')}</li>
                ))}
              </ul>
            ) : null}
          </Notice>
        ) : null}
        <Button type="submit" disabled={busy || !amount || Boolean(amountError) || !destination}>
          {busy ? 'Checking…' : 'Review withdrawal'}
        </Button>
      </form>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wider text-fg-subtle">{label}</dt>
      <dd className="mt-1">{value}</dd>
    </div>
  );
}
