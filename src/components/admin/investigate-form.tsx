'use client';
import { useState } from 'react';
import { apiPost } from '@/lib/api-client';
import { Button, Field, Input, Notice, Select } from '@/components/ui/primitives';

export function InvestigateForm({ networks }: { networks: { id: number; name: string }[] }) {
  const [networkId, setNetworkId] = useState(networks[0]?.id ?? 0);
  const [txHash, setTxHash] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await apiPost('/api/admin/deposits/investigate', { networkId, txHash: txHash.trim() });
        setMsg(r.ok ? { ok: true, text: 'Lookup queued. Results appear in the deposit list and audit log.' } : { ok: false, text: r.error ?? 'Failed' });
      }}
    >
      <Field label="Network" htmlFor="inv-net">
        <Select id="inv-net" value={networkId} onChange={(e) => setNetworkId(Number(e.target.value))}>
          {networks.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
        </Select>
      </Field>
      <div className="min-w-80 flex-1">
        <Field label="Transaction hash" htmlFor="inv-tx">
          <Input id="inv-tx" value={txHash} onChange={(e) => setTxHash(e.target.value)} placeholder="0x… or sim:0x…" />
        </Field>
      </div>
      <Button type="submit" variant="secondary" disabled={txHash.length < 10}>Investigate</Button>
      {msg ? <div className="w-full"><Notice tone={msg.ok ? 'success' : 'danger'}>{msg.text}</Notice></div> : null}
    </form>
  );
}
