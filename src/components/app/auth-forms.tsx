'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { supabaseBrowser } from '@/lib/supabase/browser';
import { Button, Field, Input, Notice } from '@/components/ui/primitives';

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

export function LoginForm() {
  const router = useRouter();
  const { busy, error, run } = useSubmit();
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    void run(async () => {
      const supabase = supabaseBrowser();
      const { error } = await supabase.auth.signInWithPassword({ email: String(f.get('email')), password: String(f.get('password')) });
      if (error) throw new Error(error.message === 'Email not confirmed' ? 'Please verify your email address first.' : 'Invalid email or password.');
      const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      router.replace(data?.nextLevel === 'aal2' && data.currentLevel !== 'aal2' ? '/login/mfa' : '/dashboard');
      router.refresh();
    });
  };
  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <Field label="Email" htmlFor="email">
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </Field>
      <Field label="Password" htmlFor="password">
        <Input id="password" name="password" type="password" autoComplete="current-password" required />
      </Field>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Button type="submit" disabled={busy} className="w-full">{busy ? 'Signing in…' : 'Sign in'}</Button>
    </form>
  );
}

export function RegisterForm() {
  const { busy, error, setError, run } = useSubmit();
  const [sent, setSent] = useState(false);
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const password = String(f.get('password'));
    if (password !== String(f.get('confirm'))) return setError('Passwords do not match.');
    if (!f.get('terms')) return setError('Please confirm you have read the risk disclosure.');
    void run(async () => {
      const { error } = await supabaseBrowser().auth.signUp({
        email: String(f.get('email')),
        password,
        options: { emailRedirectTo: `${window.location.origin}/auth/callback?next=/dashboard` },
      });
      if (error) throw new Error(error.message);
      setSent(true);
    });
  };
  if (sent) return <Notice tone="success" title="Check your inbox">Follow the link in the email to verify your address. (Local dev: open Mailpit at http://127.0.0.1:54324.)</Notice>;
  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <Field label="Email" htmlFor="email">
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </Field>
      <Field label="Password" htmlFor="password" hint={PASSWORD_HINT}>
        <Input id="password" name="password" type="password" autoComplete="new-password" minLength={12} required />
      </Field>
      <Field label="Confirm password" htmlFor="confirm">
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
      </Field>
      <label className="flex items-start gap-2 text-sm text-fg-muted">
        <input type="checkbox" name="terms" className="mt-1" />
        <span>I understand this is a testnet demonstration, that investing involves risk of loss, and I have read the <a href="/disclosures" className="text-accent hover:underline" target="_blank">risk disclosure</a>.</span>
      </label>
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
    <form onSubmit={onSubmit} className="space-y-4">
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
    <form onSubmit={onSubmit} className="space-y-4">
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
    <form onSubmit={onSubmit} className="space-y-4">
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
