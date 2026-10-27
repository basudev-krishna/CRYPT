'use client';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { apiDelete, apiPost } from '@/lib/api-client';
import { Button, Card, CardHeader, Field, Input, Notice, Textarea } from '@/components/ui/primitives';

interface Wallet {
  id: string;
  networkId: number;
  address: string;
  createdAt: string;
}

/** Minimal EIP-1193 surface (MetaMask, Trust Wallet, Rabby…). */
type Eip1193 = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };
const injected = (): Eip1193 | null => (typeof window !== 'undefined' ? ((window as unknown as { ethereum?: Eip1193 }).ethereum ?? null) : null);

const noSubscribe = () => () => {};

async function fetchWallets(): Promise<Wallet[]> {
  const res = await fetch('/api/deposits/wallets').catch(() => null);
  return res?.ok ? ((await res.json()) as { items: Wallet[] }).items : [];
}

const utf8Hex = (s: string) => '0x' + Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * The member's registered sending wallets for the group wallet. Deposits are
 * credited by sender, so each wallet is registered with a signed message proving
 * the member controls it.
 */
export function MemberWallets({ networkId, networkName, onChange }: { networkId: number; networkName: string; onChange?: () => void }) {
  const [wallets, setWallets] = useState<Wallet[] | null>(null);
  const [address, setAddress] = useState('');
  const [challenge, setChallenge] = useState<{ message: string; issuedAt: string; address: string } | null>(null);
  const [signature, setSignature] = useState('');
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // An injected wallet never appears or disappears without a reload; false on the server.
  const hasWallet = useSyncExternalStore(noSubscribe, () => injected() !== null, () => false);

  useEffect(() => {
    let cancelled = false;
    fetchWallets().then((items) => {
      if (!cancelled) setWallets(items.filter((w) => w.networkId === networkId));
    });
    return () => {
      cancelled = true;
    };
  }, [networkId, reloadKey]);
  const load = () => setReloadKey((k) => k + 1);

  async function connect() {
    const eth = injected();
    if (!eth) return;
    try {
      const accounts = (await eth.request({ method: 'eth_requestAccounts' })) as string[];
      if (accounts[0]) setAddress(accounts[0]);
    } catch {
      setMsg({ tone: 'danger', text: 'The wallet did not share an address.' });
    }
  }

  async function getMessage() {
    setMsg(null);
    setSignature('');
    setBusy(true);
    const r = await apiPost<{ message: string; issuedAt: string }>('/api/deposits/wallets/challenge', { networkId, address: address.trim() });
    setBusy(false);
    if (r.ok && r.data) setChallenge({ ...r.data, address: address.trim() });
    else setMsg({ tone: 'danger', text: r.error ?? 'Could not create the message' });
  }

  async function signInBrowser() {
    const eth = injected();
    if (!eth || !challenge) return;
    try {
      const sig = (await eth.request({ method: 'personal_sign', params: [utf8Hex(challenge.message), challenge.address] })) as string;
      setSignature(sig);
    } catch {
      setMsg({ tone: 'danger', text: 'Signing was cancelled in the wallet.' });
    }
  }

  async function register() {
    if (!challenge) return;
    setBusy(true);
    const r = await apiPost<Wallet>('/api/deposits/wallets', { networkId, address: challenge.address, issuedAt: challenge.issuedAt, signature: signature.trim() });
    setBusy(false);
    if (!r.ok) {
      setMsg({ tone: 'danger', text: r.error ?? 'Registration failed' });
      return;
    }
    setMsg({ tone: 'success', text: 'Wallet registered. Deposits sent from it are credited to you automatically.' });
    setChallenge(null);
    setAddress('');
    setSignature('');
    load();
    onChange?.();
  }

  async function remove(id: string) {
    if (!window.confirm('Stop crediting deposits from this wallet to you? Past deposits are not affected.')) return;
    const r = await apiDelete(`/api/deposits/wallets/${id}`);
    if (!r.ok) setMsg({ tone: 'danger', text: r.error ?? 'Could not remove the wallet' });
    load();
    onChange?.();
  }

  return (
    <Card>
      <CardHeader
        title="Your sending wallets"
        subtitle={`Everyone deposits to the same group wallet, so we credit you by the wallet you send from. Register every wallet you will send from on ${networkName}.`}
      />
      {wallets === null ? null : wallets.length === 0 ? (
        <Notice tone="warn" title="No wallet registered yet">
          Register your wallet before you send. Deposits from an unregistered wallet are held until an administrator assigns them.
        </Notice>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {wallets.map((w) => (
            <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <code className="break-all font-mono text-xs">{w.address}</code>
              <Button variant="secondary" className="h-8 px-3 text-xs" onClick={() => remove(w.id)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-5 space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-64 flex-1">
            <Field label="Wallet address" htmlFor="member-wallet" hint="A wallet you hold the keys for. Exchange accounts (Binance etc.) can't sign, so they can't be registered.">
              <Input id="member-wallet" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="0x…" autoComplete="off" spellCheck={false} />
            </Field>
          </div>
          {hasWallet ? (
            <Button variant="secondary" onClick={connect}>
              Use connected wallet
            </Button>
          ) : null}
          <Button onClick={getMessage} disabled={busy || !/^0x[0-9a-fA-F]{40}$/.test(address.trim())}>
            Get message to sign
          </Button>
        </div>

        {challenge ? (
          <div className="space-y-3 rounded-lg border border-border p-4">
            <Field label="Message to sign" htmlFor="proof-message" hint="Sign this exact text with the wallet above (the browser button below, or your wallet app's “Sign message” feature). It expires in 30 minutes.">
              <Textarea id="proof-message" value={challenge.message} readOnly rows={7} className="font-mono text-xs" />
            </Field>
            {hasWallet ? (
              <Button variant="secondary" onClick={signInBrowser}>
                Sign with browser wallet
              </Button>
            ) : null}
            <Field label="Signature" htmlFor="proof-signature">
              <Input id="proof-signature" value={signature} onChange={(e) => setSignature(e.target.value)} placeholder="0x…" autoComplete="off" spellCheck={false} />
            </Field>
            <Button onClick={register} disabled={busy || !/^0x[0-9a-fA-F]{130}$/.test(signature.trim())}>
              Register wallet
            </Button>
          </div>
        ) : null}

        {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
      </div>
    </Card>
  );
}
