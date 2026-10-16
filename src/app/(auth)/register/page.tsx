import type { Metadata } from 'next';
import Link from 'next/link';
import { Card } from '@/components/ui/primitives';
import { RegisterForm } from '@/components/app/auth-forms';

export const metadata: Metadata = { title: 'Create account' };

export default function RegisterPage() {
  return (
    <Card>
      <h1 className="mb-1 text-xl font-semibold">Create account</h1>
      <p className="mb-6 text-sm text-fg-muted">We will email you a link to verify your address.</p>
      <RegisterForm />
      <p className="mt-6 text-sm text-fg-muted">
        Already registered? <Link href="/login" className="text-accent hover:underline">Sign in</Link>
      </p>
    </Card>
  );
}
