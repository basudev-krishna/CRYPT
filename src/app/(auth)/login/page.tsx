import type { Metadata } from 'next';
import Link from 'next/link';
import { Card, Notice } from '@/components/ui/primitives';
import { LoginForm } from '@/components/app/auth-forms';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ notice?: string }> }) {
  const { notice } = await searchParams;
  return (
    <Card className="p-6 sm:p-8">
      <h1 className="text-2xl font-semibold tracking-tight">Sign in to EliteWhale</h1>
      <p className="mb-6 mt-1 text-sm text-fg-muted">Enter your username or email and password.</p>
      {notice === 'verify' ? (
        <div className="mb-4">
          <Notice tone="warn" title="Verify your email">Open the confirmation link we sent you, then sign in.</Notice>
        </div>
      ) : null}
      {notice === 'link-expired' ? (
        <div className="mb-4">
          <Notice tone="warn" title="Link expired">That link is invalid or has expired. Sign in, or request a new password reset.</Notice>
        </div>
      ) : null}
      {notice === 'reset' ? (
        <div className="mb-4">
          <Notice tone="success">Password updated. Sign in with your new password.</Notice>
        </div>
      ) : null}
      <LoginForm />
      <div className="mt-4 text-right text-sm">
        <Link href="/forgot-password" className="text-fg-muted hover:text-fg">Forgot password?</Link>
      </div>
      <p className="mt-6 text-center text-sm text-fg-muted">
        Don&apos;t have an account? <Link href="/register" className="font-medium text-accent hover:underline">Register now</Link>
      </p>
    </Card>
  );
}
