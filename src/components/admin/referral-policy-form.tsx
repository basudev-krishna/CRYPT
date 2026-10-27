'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPost } from '@/lib/api-client';
import { Button, Field, Input, Notice, Select, Textarea } from '@/components/ui/primitives';

interface Tier {
  label: string;
  min_qualified: number;
}

/** "EW1:1, EW2:3" ↔ tiers. Invalid input is reported, never guessed. */
function parseTiers(text: string): Tier[] | null {
  const parts = text.split(',').map((p) => p.trim()).filter(Boolean);
  const tiers: Tier[] = [];
  for (const p of parts) {
    const m = /^([A-Za-z0-9 ]{1,16}?)\s*:\s*(\d{1,6})$/.exec(p);
    if (!m) return null;
    tiers.push({ label: m[1]!.trim(), min_qualified: Number.parseInt(m[2]!, 10) });
  }
  return tiers;
}

/**
 * Save a new referral policy version. Every save is a new immutable version,
 * audited and alerted; it applies to rewards recorded from then on.
 */
export function ReferralPolicyForm({
  initial,
}: {
  initial: { enabled: boolean; reward_amount: string; program_start: string; tiers: Tier[] };
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initial.enabled ? 'true' : 'false');
  const [amount, setAmount] = useState(initial.reward_amount);
  const [start, setStart] = useState(initial.program_start.slice(0, 10));
  const [tiers, setTiers] = useState(initial.tiers.map((t) => `${t.label}:${t.min_qualified}`).join(', '));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const parsed = parseTiers(tiers);

  async function submit() {
    if (!parsed) return;
    const on = enabled === 'true';
    if (!window.confirm(on ? `Pay ${amount} per qualified referral from the referral fund (after your approval of each)?` : 'Save with rewards switched off?')) return;
    setBusy(true);
    setMsg(null);
    const r = await apiPost('/api/admin/referral-policy', {
      note,
      policy: { enabled: on, reward_amount: amount.trim(), program_start: new Date(`${start}T00:00:00Z`).toISOString(), tiers: parsed },
    });
    setBusy(false);
    if (!r.ok) setMsg({ ok: false, text: r.error ?? 'Failed' });
    else {
      setMsg({ ok: true, text: 'Saved as a new policy version.' });
      setNote('');
      router.refresh();
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Rewards" htmlFor="ref-enabled">
          <Select id="ref-enabled" value={enabled} onChange={(e) => setEnabled(e.target.value)}>
            <option value="false">Off</option>
            <option value="true">On</option>
          </Select>
        </Field>
        <Field label="Reward per qualified referral (USDT)" htmlFor="ref-amount">
          <Input id="ref-amount" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
        </Field>
        <Field label="Count members who joined from (UTC)" htmlFor="ref-start">
          <Input id="ref-start" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
      </div>
      <Field label="Tiers (label:qualified referrals)" htmlFor="ref-tiers" error={parsed ? null : 'Use the form EW1:1, EW2:3, with increasing numbers'} hint="Recognition only; tiers carry no money.">
        <Input id="ref-tiers" value={tiers} onChange={(e) => setTiers(e.target.value)} spellCheck={false} />
      </Field>
      <Field label="Reason for the change" htmlFor="ref-note">
        <Textarea id="ref-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
      </Field>
      <Button className="h-8 px-3 text-xs" disabled={busy || !parsed || note.trim().length < 10 || !start} onClick={submit}>
        {busy ? '…' : 'Save new version'}
      </Button>
      {msg ? <Notice tone={msg.ok ? 'success' : 'danger'}>{msg.text}</Notice> : null}
    </div>
  );
}
