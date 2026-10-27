import type { Metadata } from 'next';
import { pageUser } from '@/server/http/auth';
import { Card, CardHeader, PageHeader } from '@/components/ui/primitives';
import { MfaEnroll } from '@/components/app/actions';

export const metadata: Metadata = { title: 'Security' };

export default async function SecurityPage() {
  const user = await pageUser();
  return (
    <>
      <PageHeader title="Security" />
      <Card className="max-w-2xl">
        <CardHeader title="Two-factor authentication" subtitle="Optional. Once enabled, every sign-in asks for a code from your authenticator app." />
        <MfaEnroll enrolled={user.hasMfaFactor} />
      </Card>
    </>
  );
}
