import type { Metadata } from 'next';
import Link from 'next/link';
import { Card, Notice } from '@/components/ui/primitives';
import { LoginForm } from '@/components/app/auth-forms';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ notice?: string }> }) {
  const { notice } = await searchParams;
  return (
    <Card>
      <h1 className="mb-1 text-xl font-semibold">Sign in</h1>
      <p className="mb-6 text-sm text-fg-muted">Access your testnet account.</p>
      {notice === 'verify' ? (
        <div className="mb-4">
          <Notice tone="warn" title="Verify your email">Open the confirmation link we sent you, then sign in.</Notice>
        </div>
      ) : null}
      {notice === 'reset' ? (
        <div className="mb-4">
          <Notice tone="success">Password updated. Sign in with your new password.</Notice>
        </div>
      ) : null}
      <LoginForm />
      <div className="mt-6 flex justify-between text-sm">
        <Link href="/register" className="text-accent hover:underline">Create account</Link>
        <Link href="/forgot-password" className="text-fg-muted hover:text-fg">Forgot password?</Link>
      </div>
    </Card>
  );
}
