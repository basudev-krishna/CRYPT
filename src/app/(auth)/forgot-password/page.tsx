import type { Metadata } from 'next';
import { Card } from '@/components/ui/primitives';
import { ForgotPasswordForm } from '@/components/app/auth-forms';

export const metadata: Metadata = { title: 'Reset password' };

export default function ForgotPage() {
  return (
    <Card>
      <h1 className="mb-1 text-xl font-semibold">Reset password</h1>
      <p className="mb-6 text-sm text-fg-muted">We will email a reset link if an account exists for this address.</p>
      <ForgotPasswordForm />
    </Card>
  );
}
