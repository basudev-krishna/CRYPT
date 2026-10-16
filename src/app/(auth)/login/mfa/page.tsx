import type { Metadata } from 'next';
import { Card } from '@/components/ui/primitives';
import { MfaChallengeForm } from '@/components/app/auth-forms';

export const metadata: Metadata = { title: 'Two-factor verification' };

export default function MfaPage() {
  return (
    <Card>
      <h1 className="mb-1 text-xl font-semibold">Two-factor verification</h1>
      <p className="mb-6 text-sm text-fg-muted">Enter the 6-digit code from your authenticator app.</p>
      <MfaChallengeForm />
    </Card>
  );
}
