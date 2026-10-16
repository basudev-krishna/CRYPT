import type { Metadata } from 'next';
import { pageUser } from '@/server/http/auth';
import { Card, CardHeader, Notice, PageHeader } from '@/components/ui/primitives';
import { MfaEnroll } from '@/components/app/actions';

export const metadata: Metadata = { title: 'Security' };

export default async function SecurityPage({ searchParams }: { searchParams: Promise<{ notice?: string }> }) {
  const user = await pageUser();
  const { notice } = await searchParams;
  return (
    <>
      <PageHeader title="Security" />
      {notice === 'staff-mfa' ? (
        <div className="mb-6"><Notice tone="warn" title="Two-factor authentication required">Staff accounts must use an authenticator app (and an MFA-verified session) to access the console.</Notice></div>
      ) : null}
      <Card className="max-w-2xl">
        <CardHeader title="Two-factor authentication" subtitle="Required for withdrawals and for all staff accounts." />
        <MfaEnroll enrolled={user.hasMfaFactor} />
      </Card>
    </>
  );
}
