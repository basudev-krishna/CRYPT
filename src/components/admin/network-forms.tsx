'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPost } from '@/lib/api-client';
import { Button, Field, Input, Notice, Select, Textarea } from '@/components/ui/primitives';

const CODE = /^EW-[0-9]{6,}$/i;

function useSubmit() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function run(url: string, payload: unknown): Promise<boolean> {
    setBusy(true);
    setMsg(null);
    const r = await apiPost(url, payload);
    setBusy(false);
    setMsg(r.ok ? { ok: true, text: 'Saved.' } : { ok: false, text: r.error ?? 'Failed' });
    if (r.ok) router.refresh();
    return r.ok;
  }
  return { busy, run, notice: msg ? <Notice tone={msg.ok ? 'success' : 'danger'}>{msg.text}</Notice> : null };
}

/** Change who referred this member; leave the id empty to clear it. */
export function SponsorForm({ userId, current }: { userId: string; current: string | null }) {
  const [code, setCode] = useState(current ?? '');
  const [reason, setReason] = useState('');
  const { busy, run, notice } = useSubmit();
  const valid = code.trim() === '' || CODE.test(code.trim());
  return (
    <div className="space-y-3">
      <Field label="Referred by (member id)" htmlFor="sp-code" hint="Leave empty to clear." error={valid ? null : 'Member ids look like EW-000123'}>
        <Input id="sp-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="EW-000123" maxLength={12} />
      </Field>
      <Field label="Reason" htmlFor="sp-reason">
        <Textarea id="sp-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
      </Field>
      <Button
        className="h-8 px-3 text-xs"
        variant="secondary"
        disabled={busy || !valid || reason.trim().length < 10}
        onClick={async () => {
          if (await run(`/api/admin/users/${userId}/sponsor`, { sponsorMemberCode: code.trim() ? code.trim().toUpperCase() : null, reason })) setReason('');
        }}
      >
        {busy ? '…' : 'Save referrer'}
      </Button>
      {notice}
    </div>
  );
}

/** Place or move this member (and their team) left or right under any parent; a taken spot's member moves down under them. */
export function PlacementForm({ userId, parent, side: currentSide }: { userId: string; parent: string | null; side: 'left' | 'right' | null }) {
  const [code, setCode] = useState(parent ?? '');
  const [side, setSide] = useState<'left' | 'right'>(currentSide ?? 'left');
  const [reason, setReason] = useState('');
  const { busy, run, notice } = useSubmit();
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Under member" htmlFor="pl-code">
          <Input id="pl-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="EW-000123" maxLength={12} />
        </Field>
        <Field label="Side" htmlFor="pl-side" hint="Any spot: if taken, the member there moves down under this one.">
          <Select id="pl-side" value={side} onChange={(e) => setSide(e.target.value as 'left' | 'right')}>
            <option value="left">Left</option>
            <option value="right">Right</option>
          </Select>
        </Field>
      </div>
      <Field label="Reason" htmlFor="pl-reason">
        <Textarea id="pl-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
      </Field>
      <Button
        className="h-8 px-3 text-xs"
        variant="secondary"
        disabled={busy || !CODE.test(code.trim()) || reason.trim().length < 10}
        onClick={async () => {
          if (await run(`/api/admin/users/${userId}/placement`, { parentMemberCode: code.trim().toUpperCase(), side, reason })) setReason('');
        }}
      >
        {busy ? '…' : parent ? 'Move' : 'Place'}
      </Button>
      {notice}
    </div>
  );
}
