import type { Metadata } from 'next';
import { Card } from '@/components/ui/primitives';
import { ResetPasswordForm } from '@/components/app/auth-forms';

export const metadata: Metadata = { title: 'Choose a new password' };

export default function ResetPage() {
  return (
    <Card>
      <h1 className="mb-6 text-xl font-semibold">Choose a new password</h1>
      <ResetPasswordForm />
    </Card>
  );
}
