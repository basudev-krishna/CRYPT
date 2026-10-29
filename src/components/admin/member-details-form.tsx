'use client';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useSyncExternalStore } from 'react';
import { apiPost } from '@/lib/api-client';
import { COUNTRIES } from '@/lib/countries';
import { Button, Field, Input, Notice, Select } from '@/components/ui/primitives';

const noopSubscribe = () => () => {};

export interface MemberDetailsValue {
  fullName: string;
  username: string;
  phone: string;
  countryCode: string;
}

/** Administrator: correct a member's name, login username, phone and country. */
export function MemberDetailsForm({ userId, initial }: { userId: string; initial: MemberDetailsValue }) {
  const router = useRouter();
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // Country names differ between Node and browsers, so the list is built after hydration.
  const hydrated = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
  const countries = useMemo(() => {
    if (!hydrated) return [];
    const names = new Intl.DisplayNames(['en'], { type: 'region' });
    return COUNTRIES.map(([code]) => ({ code, name: names.of(code) ?? code })).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  }, [hydrated]);
  const set = (k: keyof MemberDetailsValue) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });
  const changed = (Object.keys(v) as (keyof MemberDetailsValue)[]).some((k) => v[k] !== initial[k]);

  return (
    <form
      method="post"
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (v.username.trim().toLowerCase() !== initial.username && v.username.trim() && !window.confirm(`Change their sign-in username to "${v.username.trim().toLowerCase()}"? Tell them; the old one stops working.`)) return;
        setBusy(true);
        setMsg(null);
        const r = await apiPost(`/api/admin/users/${userId}/details`, v);
        setBusy(false);
        setMsg(r.ok ? { ok: true, text: 'Saved.' } : { ok: false, text: r.error ?? 'Failed' });
        if (r.ok) router.refresh();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Full name" htmlFor="md-name">
          <Input id="md-name" value={v.fullName} onChange={set('fullName')} maxLength={60} required />
        </Field>
        <Field label="Username (sign-in)" htmlFor="md-username" hint="4–20 letters, digits or underscore">
          <Input id="md-username" value={v.username} onChange={set('username')} maxLength={20} autoCapitalize="none" required={Boolean(initial.username)} />
        </Field>
        <Field label="Phone" htmlFor="md-phone" hint="Optional. With country code, e.g. +91 98765 43210">
          <Input id="md-phone" value={v.phone} onChange={set('phone')} inputMode="tel" />
        </Field>
        <Field label="Country" htmlFor="md-country">
          <Select id="md-country" value={v.countryCode} onChange={set('countryCode')}>
            <option value="">Not set</option>
            {hydrated ? null : v.countryCode ? <option value={v.countryCode}>{v.countryCode}</option> : null}
            {countries.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Button type="submit" className="h-8 px-3 text-xs" disabled={busy || !changed}>
        {busy ? '…' : 'Save details'}
      </Button>
      {msg ? <Notice tone={msg.ok ? 'success' : 'danger'}>{msg.text}</Notice> : null}
    </form>
  );
}
