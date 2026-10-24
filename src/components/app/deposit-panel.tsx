'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { apiPost } from '@/lib/api-client';
import { Badge, Button, Card, CardHeader, Field, Input, Notice, Select } from '@/components/ui/primitives';
import { fmt } from '@/components/ui/money';
import { MemberWallets } from './member-wallets';

interface NetworkOption {
  id: number;
  name: string;
  symbol: string;
  isSimulated: boolean;
  isTestToken: boolean;
}

interface Instructions {
  network: { id: number; code: string; name: string; isTestnet: boolean; isSimulated: boolean; requiredConfirmations: number };
  token: { id: number; symbol: string; contractAddress: string; decimals: number; isTestToken: boolean };
  address: string;
  mode: 'group_wallet' | 'deposit_address';
  minDepositBase: string;
}

export function DepositPanel({ networks, demoMode }: { networks: NetworkOption[]; demoMode: boolean }) {
  const router = useRouter();
  const [networkId, setNetworkId] = useState<number | null>(networks[0]?.id ?? null);
  const [ins, setIns] = useState<Instructions | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!ins) return;
    // Only the address is encoded: wallets must still be set to the right network manually.
    QRCode.toDataURL(ins.address, { margin: 1, width: 180, color: { dark: '#192837', light: '#ffffff' } }).then(setQr, () => setQr(null));
  }, [ins]);

  async function load() {
    if (!networkId) return;
    setBusy(true);
    setError(null);
    const r = await apiPost<Instructions>('/api/deposits/instructions', { networkId });
    setBusy(false);
    if (r.ok && r.data) setIns(r.data);
    else setError({ message: r.error ?? 'Could not load deposit instructions', code: r.code });
  }

  if (networks.length === 0) return <Notice tone="warn" title="No networks available">No deposit network is currently active.</Notice>;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="1. Choose network" subtitle="Deposits are only detected on the network you select. Tokens sent on any other network are not credited automatically." />
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-64 flex-1">
            <Field label="Network" htmlFor="network">
              <Select
                id="network"
                value={networkId ?? ''}
                onChange={(e) => {
                  setNetworkId(Number(e.target.value));
                  setIns(null);
                }}
              >
                {networks.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name} · {n.symbol}
                    {n.isSimulated ? ' (simulated)' : ''}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Button onClick={load} disabled={busy || !networkId}>
            {busy ? 'Loading…' : 'Show deposit address'}
          </Button>
        </div>
        {error ? (
          <div className="mt-4">
            <Notice tone={error.code === 'kyc_required' || error.code === 'disclosure_required' ? 'warn' : 'danger'} title="Deposit unavailable">
              {error.message}
              {error.code === 'kyc_required' ? (
                <>
                  {' '}
                  <a className="text-accent hover:underline" href="/settings">Complete verification →</a>
                </>
              ) : null}
              {error.code === 'disclosure_required' ? (
                <>
                  {' '}
                  <a className="text-accent hover:underline" href="/disclosures">Review disclosure →</a>
                </>
              ) : null}
            </Notice>
          </div>
        ) : null}
      </Card>

      {ins?.mode === 'group_wallet' ? <MemberWallets networkId={ins.network.id} networkName={ins.network.name} /> : null}

      {ins ? (
        <Card>
          <CardHeader
            title={ins.mode === 'group_wallet' ? '2. Send to the group wallet' : '2. Send tokens to this address'}
            action={
              <div className="flex gap-2">
                {ins.network.isSimulated ? (
                  <Badge tone="sim">Simulated network</Badge>
                ) : ins.network.isTestnet ? (
                  <Badge tone="info">Testnet</Badge>
                ) : (
                  <Badge tone="warn">Real funds · {ins.network.name}</Badge>
                )}
                {ins.token.isTestToken ? <Badge tone="warn">Test token · no value</Badge> : null}
              </div>
            }
          />
          <div className="grid gap-6 md:grid-cols-[180px_1fr]">
            <div className="grid h-[180px] w-[180px] place-items-center rounded-lg bg-fg/90">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {qr ? <img src={qr} alt={`QR code for deposit address ${ins.address}`} width={180} height={180} className="rounded-lg" /> : null}
            </div>
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-xs uppercase tracking-wider text-fg-subtle">{ins.mode === 'group_wallet' ? 'Group wallet address' : 'Deposit address'}</dt>
                <dd className="mt-1 flex flex-wrap items-center gap-2">
                  <code className="break-all rounded-lg bg-surface-3 px-2.5 py-1.5 font-mono text-xs">{ins.address}</code>
                  <Button
                    variant="secondary"
                    className="h-8 px-3 text-xs"
                    onClick={async () => {
                      await navigator.clipboard.writeText(ins.address);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    }}
                  >
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                </dd>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <dt className="text-xs uppercase tracking-wider text-fg-subtle">Network</dt>
                  <dd className="mt-1">{ins.network.name}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wider text-fg-subtle">Token contract</dt>
                  <dd className="mt-1 break-all font-mono text-xs text-fg-muted">{ins.token.contractAddress}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wider text-fg-subtle">Minimum deposit</dt>
                  <dd className="num mt-1">
                    {fmt(ins.minDepositBase, ins.token.decimals)} {ins.token.symbol}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wider text-fg-subtle">Confirmations required</dt>
                  <dd className="num mt-1">{ins.network.requiredConfirmations}</dd>
                </div>
              </div>
            </dl>
          </div>
          <div className="mt-5 space-y-2">
            <Notice tone="warn" title="Before you send">
              <ul className="list-disc space-y-1 pl-5">
                <li>Send only {ins.token.symbol} on {ins.network.name}. Other tokens or networks are not credited and require a manual recovery review.</li>
                {ins.mode === 'group_wallet' ? (
                  <li>
                    Send from a wallet registered above. Deposits from exchanges or unregistered wallets are not credited to you automatically; they wait until an administrator
                    assigns them.
                  </li>
                ) : null}
                <li>Deposits below the minimum are held for review and are not invested automatically.</li>
                <li>Network fees are paid by the sender; you are credited the exact amount received.</li>
                <li>Your balance updates only after {ins.network.requiredConfirmations} confirmations and compliance checks.</li>
              </ul>
            </Notice>
          </div>
          {demoMode && ins.network.isSimulated ? <SimulateDeposit decimals={ins.token.decimals} symbol={ins.token.symbol} onDone={() => router.refresh()} /> : null}
        </Card>
      ) : null}
    </div>
  );
}

function SimulateDeposit({ decimals, symbol, onDone }: { decimals: number; symbol: string; onDone: () => void }) {
  const [amount, setAmount] = useState('100');
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="mt-6 rounded-lg border border-sim/40 bg-sim/5 p-4">
      <p className="mb-3 text-sm text-sim">
        <strong>Demo mode:</strong> simulate an external wallet sending {symbol} to this address. It then goes through the normal detection, confirmation and
        compliance pipeline.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <Field label={`Amount (${symbol})`} htmlFor="sim-amount" hint={`Up to ${decimals} decimal places`}>
          <Input id="sim-amount" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" className="w-40" />
        </Field>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const r = await apiPost<{ txHash: string }>('/api/dev/simulate-deposit', { amount });
            setBusy(false);
            setMsg(r.ok ? { tone: 'success', text: `Simulated transfer sent (${r.data?.txHash.slice(0, 18)}…). Watch it confirm below.` } : { tone: 'danger', text: r.error ?? 'Failed' });
            if (r.ok) onDone();
          }}
        >
          Simulate incoming transfer
        </Button>
      </div>
      {msg ? (
        <div className="mt-3">
          <Notice tone={msg.tone}>{msg.text}</Notice>
        </div>
      ) : null}
    </div>
  );
}
