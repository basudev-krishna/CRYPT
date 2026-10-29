import type { Metadata } from 'next';
import { pageUser } from '@/server/http/auth';
import { Card, CardHeader, PageHeader } from '@/components/ui/primitives';
import { ChangePasswordForm, MfaEnroll } from '@/components/app/actions';

export const metadata: Metadata = { title: 'Security' };

export default async function SecurityPage() {
  const user = await pageUser();
  return (
    <>
      <PageHeader title="Security" />
      <div className="grid max-w-5xl gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title="Password" subtitle="If an administrator created your account, replace the password they gave you with your own." />
          <ChangePasswordForm />
        </Card>
        <Card>
          <CardHeader title="Two-factor authentication" subtitle="Optional. Once enabled, every sign-in asks for a code from your authenticator app." />
          <MfaEnroll enrolled={user.hasMfaFactor} />
        </Card>
      </div>
    </>
  );
}
