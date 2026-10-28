import type { Metadata } from 'next';
import Link from 'next/link';
import { Card } from '@/components/ui/primitives';
import { RegisterForm } from '@/components/app/auth-forms';

export const metadata: Metadata = { title: 'Create account' };

export default async function RegisterPage({ searchParams }: { searchParams: Promise<{ email?: string; ref?: string }> }) {
  const { email, ref } = await searchParams;
  return (
    <Card className="p-6 sm:p-8">
      <h1 className="text-2xl font-semibold tracking-tight">Create your account</h1>
      <p className="mb-6 mt-1 text-sm text-fg-muted">Joining with a referral id? You will choose your team position below.</p>
      <RegisterForm email={email?.slice(0, 254) ?? ''} referralCode={ref?.slice(0, 12) ?? ''} />
      <p className="mt-6 text-center text-sm text-fg-muted">
        Already have an account? <Link href="/login" className="font-medium text-accent hover:underline">Sign in</Link>
      </p>
    </Card>
  );
}
