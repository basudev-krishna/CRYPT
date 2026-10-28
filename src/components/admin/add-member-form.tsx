'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useSyncExternalStore, type FormEvent } from 'react';
import { apiPost } from '@/lib/api-client';
import { COUNTRIES } from '@/lib/countries';
import { Button, Field, Input, Notice, Select } from '@/components/ui/primitives';

type Side = 'left' | 'right';
type FieldName = 'fullName' | 'username' | 'email' | 'phone' | 'countryCode' | 'password' | 'referralCode' | 'parentCode' | 'teamSide';

const noopSubscribe = () => () => {};

/**
 * Administrator: sign a member up directly, with their sponsor and team
 * position. Any spot can be chosen; if it is taken, the member there moves
 * down under the new member. The member verifies their email and signs in with
 * the password given here.
 */
export function AddMemberForm({ defaultSponsor }: { defaultSponsor: string }) {
  const router = useRouter();
  const [country, setCountry] = useState('');
  const [side, setSide] = useState<Side>('left');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string; href?: string } | null>(null);
  // Country names differ between Node and browsers, so the list is built after hydration.
  const hydrated = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
  const countries = useMemo(() => {
    if (!hydrated) return [];
    const names = new Intl.DisplayNames(['en'], { type: 'region' });
    return COUNTRIES.map(([code, dial]) => ({ code, dial, name: names.of(code) ?? code })).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  }, [hydrated]);
  const dial = countries.find((c) => c.code === country)?.dial;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const rawPhone = String(f.get('phone')).trim();
    const phone = rawPhone.startsWith('+') || !dial ? rawPhone : `+${dial}${rawPhone.replace(/^0+/, '')}`;
    setBusy(true);
    setErrors({});
    setMsg(null);
    const r = await apiPost<{ userId: string; memberCode: string }>('/api/admin/members', {
      fullName: String(f.get('fullName')),
      username: String(f.get('username')),
      email: String(f.get('email')),
      phone,
      countryCode: country,
      password: String(f.get('password')),
      referralCode: String(f.get('referralCode')),
      parentCode: String(f.get('parentCode')),
      teamSide: side,
    });
    setBusy(false);
    if (!r.ok) {
      if (r.code === 'validation_error') {
        const details = (r.details ?? {}) as Partial<Record<FieldName, string[]>>;
        setErrors(Object.fromEntries(Object.entries(details).map(([k, v]) => [k, v?.[0]])));
      }
      if (r.code === 'username_taken') setErrors({ username: r.error });
      if (r.code === 'referral_not_found') setErrors({ referralCode: r.error });
      if (r.code === 'parent_not_found') setErrors({ parentCode: r.error });
      setMsg({ ok: false, text: r.code === 'validation_error' ? 'Please fix the highlighted fields.' : (r.error ?? 'Failed') });
      return;
    }
    form.reset();
    setCountry('');
    setMsg({ ok: true, text: `Member ${r.data?.memberCode ?? ''} created. Share the password with them; they verify their email, then sign in.`, href: `/admin/users/${r.data?.userId}` });
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Full name" htmlFor="am-name" error={errors.fullName}>
          <Input id="am-name" name="fullName" maxLength={60} required />
        </Field>
        <Field label="Username" htmlFor="am-username" error={errors.username} hint={errors.username ? undefined : '4–20 letters, digits or _'}>
          <Input id="am-username" name="username" autoCapitalize="none" spellCheck={false} maxLength={20} required />
        </Field>
        <Field label="Email" htmlFor="am-email" error={errors.email}>
          <Input id="am-email" name="email" type="email" required />
        </Field>
        <Field label="Country" htmlFor="am-country" error={errors.countryCode}>
          <Select id="am-country" value={country} onChange={(e) => setCountry(e.target.value)} required>
            <option value="">Select…</option>
            {countries.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name} (+{c.dial})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Mobile number" htmlFor="am-phone" error={errors.phone}>
          <Input id="am-phone" name="phone" type="tel" inputMode="tel" placeholder={dial ? `+${dial} …` : '+91 98765 43210'} required />
        </Field>
        <Field label="Password" htmlFor="am-password" error={errors.password} hint={errors.password ? undefined : '12+ characters, upper- and lower-case letters and a digit'}>
          <Input id="am-password" name="password" type="text" autoComplete="off" minLength={12} required />
        </Field>
        <Field label="Sponsor (referral id)" htmlFor="am-ref" error={errors.referralCode} hint={errors.referralCode ? undefined : 'Who referred them; permanent'}>
          <Input id="am-ref" name="referralCode" defaultValue={defaultSponsor} autoCapitalize="characters" spellCheck={false} maxLength={12} required />
        </Field>
        <Field label="Place under (optional)" htmlFor="am-parent" error={errors.parentCode} hint={errors.parentCode ? undefined : 'Any member id; blank = under the sponsor'}>
          <Input id="am-parent" name="parentCode" autoCapitalize="characters" spellCheck={false} maxLength={12} />
        </Field>
        <fieldset>
          <legend className="mb-1.5 text-xs font-medium uppercase tracking-wider text-fg-muted">Side</legend>
          <div className="grid grid-cols-2 gap-1 rounded-xl bg-surface-3 p-1 ring-1 ring-black/5" role="radiogroup" aria-label="Side">
            {(['left', 'right'] as const).map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={side === s}
                onClick={() => setSide(s)}
                className={`rounded-lg px-3 py-2 text-sm font-semibold capitalize transition ${side === s ? 'bg-accent text-white shadow-sm' : 'text-fg-muted hover:bg-white hover:text-fg'}`}
              >
                {s}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-fg-subtle">If taken, the member there moves down under the new one.</p>
        </fieldset>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create member'}
        </Button>
        {msg ? (
          <Notice tone={msg.ok ? 'success' : 'danger'}>
            {msg.text}{' '}
            {msg.href ? (
              <Link className="font-medium underline" href={msg.href}>
                Open their page
              </Link>
            ) : null}
          </Notice>
        ) : null}
      </div>
    </form>
  );
}
