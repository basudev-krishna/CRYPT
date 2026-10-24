'use client';
import { useRouter } from 'next/navigation';
import { useMemo, useState, type FormEvent } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { apiPost } from '@/lib/api-client';
import { COUNTRIES } from '@/lib/countries';
import { supabaseBrowser } from '@/lib/supabase/browser';
import { Button, Field, Input, Notice, Select } from '@/components/ui/primitives';

const LOCAL_AUTH = /\/\/(127\.0\.0\.1|localhost)[:/]/.test(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '');
const PASSWORD_HINT = 'At least 12 characters with upper- and lower-case letters and a digit.';

function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

/** Password field with a show/hide toggle. */
function PasswordInput({ id, name, autoComplete, minLength }: { id: string; name: string; autoComplete: string; minLength?: number }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input id={id} name={name} type={show ? 'text' : 'password'} autoComplete={autoComplete} minLength={minLength} required className="pr-10" />
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        aria-label={show ? 'Hide password' : 'Show password'}
        className="absolute inset-y-0 right-0 grid w-10 place-items-center text-fg-muted hover:text-fg"
      >
        {show ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
      </button>
    </div>
  );
}

export function LoginForm() {
  const router = useRouter();
  const { busy, error, run } = useSubmit();
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    void run(async () => {
      // Usernames are resolved to the account email on the server, which also sets the session cookies.
      const r = await apiPost<{ next: string }>('/api/auth/login', { identifier: String(f.get('identifier')), password: String(f.get('password')) });
      if (!r.ok || !r.data) throw new Error(r.error ?? 'Sign-in failed.');
      router.replace(r.data.next);
      router.refresh();
    });
  };
  return (
    <form method="post" onSubmit={onSubmit} className="space-y-4" noValidate>
      <Field label="Username or email" htmlFor="identifier">
        <Input id="identifier" name="identifier" autoComplete="username" autoCapitalize="none" spellCheck={false} required />
      </Field>
      <Field label="Password" htmlFor="password">
        <PasswordInput id="password" name="password" autoComplete="current-password" />
      </Field>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Button type="submit" disabled={busy} className="w-full">{busy ? 'Signing in…' : 'Sign in'}</Button>
    </form>
  );
}

type RegisterField = 'fullName' | 'username' | 'email' | 'phone' | 'countryCode' | 'password' | 'confirm' | 'referralCode' | 'acceptTerms';

export function RegisterForm({ email = '', referralCode = '' }: { email?: string; referralCode?: string }) {
  const router = useRouter();
  const { busy, error, run } = useSubmit();
  const [sent, setSent] = useState(false);
  const [country, setCountry] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<RegisterField, string>>>({});
  const countries = useMemo(() => {
    const names = new Intl.DisplayNames(undefined, { type: 'region' });
    return COUNTRIES.map(([code, dial]) => ({ code, dial, name: names.of(code) ?? code })).sort((a, b) => a.name.localeCompare(b.name));
  }, []);
  const dial = countries.find((c) => c.code === country)?.dial;

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const password = String(f.get('password'));
    setFieldErrors({});
    if (password !== String(f.get('confirm'))) return setFieldErrors({ confirm: 'Passwords do not match.' });
    const rawPhone = String(f.get('phone')).trim();
    const phone = rawPhone.startsWith('+') || !dial ? rawPhone : `+${dial}${rawPhone.replace(/^0+/, '')}`;
    void run(async () => {
      const r = await apiPost<{ signedIn: boolean }>('/api/auth/register', {
        fullName: String(f.get('fullName')),
        username: String(f.get('username')),
        email: String(f.get('email')),
        phone,
        countryCode: country,
        password,
        referralCode: String(f.get('referralCode') ?? ''),
        acceptTerms: f.get('terms') === 'on',
      });
      if (!r.ok) {
        if (r.code === 'validation_error') {
          const details = (r.details ?? {}) as Partial<Record<RegisterField, string[]>>;
          setFieldErrors(Object.fromEntries(Object.entries(details).map(([k, v]) => [k, v?.[0]])));
          throw new Error('Please fix the highlighted fields.');
        }
        if (r.code === 'username_taken') setFieldErrors({ username: r.error });
        if (r.code === 'referral_not_found') setFieldErrors({ referralCode: r.error });
        throw new Error(r.error ?? 'Registration failed.');
      }
      // With email confirmation off, Auth signs the user in at once; the app then shows the approval page.
      if (r.data?.signedIn) {
        router.replace('/dashboard');
        router.refresh();
        return;
      }
      setSent(true);
    });
  };
  if (sent) {
    return (
      <Notice tone="success" title="Check your inbox">
        Follow the link in the email to verify your address. An administrator then reviews your account; you can use it once it is approved.
        {LOCAL_AUTH ? ' (Local dev: open Mailpit at http://127.0.0.1:54324.)' : null}
      </Notice>
    );
  }
  const fe = fieldErrors;
  return (
    <form method="post" onSubmit={onSubmit} className="space-y-4" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Full name" htmlFor="fullName" error={fe.fullName}>
          <Input id="fullName" name="fullName" autoComplete="name" maxLength={60} required />
        </Field>
        <Field label="Username" htmlFor="username" error={fe.username} hint={fe.username ? undefined : '4–20 letters, digits or _'}>
          <Input id="username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={20} required />
        </Field>
      </div>
      <Field label="Email" htmlFor="email" error={fe.email}>
        <Input id="email" name="email" type="email" autoComplete="email" defaultValue={email} required />
      </Field>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <Field label="Country" htmlFor="countryCode" error={fe.countryCode}>
          <Select id="countryCode" name="countryCode" value={country} onChange={(e) => setCountry(e.target.value)} required autoComplete="country">
            <option value="">Select…</option>
            {countries.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name} (+{c.dial})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Mobile number" htmlFor="phone" error={fe.phone}>
          <div className="flex">
            {dial ? <span className="grid place-items-center rounded-l-lg border border-r-0 border-line bg-surface-3 px-3 text-sm text-fg-muted">+{dial}</span> : null}
            <Input id="phone" name="phone" type="tel" inputMode="tel" autoComplete="tel-national" placeholder={dial ? '98765 43210' : '+91 98765 43210'} className={dial ? 'rounded-l-none' : undefined} required />
          </div>
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Password" htmlFor="password" error={fe.password} hint={fe.password ? undefined : PASSWORD_HINT}>
          <PasswordInput id="password" name="password" autoComplete="new-password" minLength={12} />
        </Field>
        <Field label="Confirm password" htmlFor="confirm" error={fe.confirm}>
          <PasswordInput id="confirm" name="confirm" autoComplete="new-password" />
        </Field>
      </div>
      <Field label="Referral id (optional)" htmlFor="referralCode" error={fe.referralCode} hint={fe.referralCode ? undefined : 'Member id of the person who referred you, e.g. EW-000123'}>
        <Input id="referralCode" name="referralCode" defaultValue={referralCode} autoCapitalize="characters" spellCheck={false} maxLength={12} />
      </Field>
      <label className="flex items-start gap-2 text-sm text-fg-muted">
        <input type="checkbox" name="terms" className="mt-1" />
        <span>
          I accept the terms and have read the <a href="/disclosures" className="text-accent hover:underline" target="_blank">risk disclosure</a>. Crypto transfers cannot be reversed and you can lose money.
        </span>
      </label>
      {fe.acceptTerms ? <p className="text-xs text-loss">{fe.acceptTerms}</p> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Button type="submit" disabled={busy} className="w-full">{busy ? 'Creating account…' : 'Create account'}</Button>
    </form>
  );
}

export function MfaChallengeForm({ onDone }: { onDone?: () => void }) {
  const router = useRouter();
  const { busy, error, run } = useSubmit();
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get('code')).replace(/\s/g, '');
    void run(async () => {
      const supabase = supabaseBrowser();
      const { data: factors, error: fErr } = await supabase.auth.mfa.listFactors();
      if (fErr) throw new Error(fErr.message);
      const factor = factors.totp.find((f) => f.status === 'verified');
      if (!factor) throw new Error('No authenticator is enrolled on this account.');
      const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
      if (error) throw new Error('That code is not valid. Try the current code.');
      if (onDone) onDone();
      else {
        router.replace('/dashboard');
        router.refresh();
      }
    });
  };
  return (
    <form method="post" onSubmit={onSubmit} className="space-y-4">
      <Field label="Authentication code" htmlFor="code">
        <Input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required />
      </Field>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Button type="submit" disabled={busy} className="w-full">{busy ? 'Verifying…' : 'Verify'}</Button>
    </form>
  );
}

export function ForgotPasswordForm() {
  const { busy, error, run } = useSubmit();
  const [sent, setSent] = useState(false);
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get('email'));
    void run(async () => {
      await supabaseBrowser().auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/auth/callback?next=/reset-password` });
      setSent(true); // same response whether or not the account exists
    });
  };
  if (sent) return <Notice tone="success">If an account exists for that address, a reset link is on its way.</Notice>;
  return (
    <form method="post" onSubmit={onSubmit} className="space-y-4">
      <Field label="Email" htmlFor="email">
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </Field>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Button type="submit" disabled={busy} className="w-full">Send reset link</Button>
    </form>
  );
}

export function ResetPasswordForm() {
  const router = useRouter();
  const { busy, error, setError, run } = useSubmit();
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const password = String(f.get('password'));
    if (password !== String(f.get('confirm'))) return setError('Passwords do not match.');
    void run(async () => {
      const supabase = supabaseBrowser();
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw new Error(error.message);
      await supabase.auth.signOut({ scope: 'global' }); // revoke other sessions
      router.replace('/login?notice=reset');
    });
  };
  return (
    <form method="post" onSubmit={onSubmit} className="space-y-4">
      <Field label="New password" htmlFor="password" hint={PASSWORD_HINT}>
        <Input id="password" name="password" type="password" autoComplete="new-password" minLength={12} required />
      </Field>
      <Field label="Confirm new password" htmlFor="confirm">
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
      </Field>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Button type="submit" disabled={busy} className="w-full">Update password</Button>
    </form>
  );
}
