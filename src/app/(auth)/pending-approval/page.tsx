import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getSessionUser } from '@/server/http/auth';
import { Card, Notice } from '@/components/ui/primitives';
import { SignOutButton } from '@/components/app/sign-out-button';

export const metadata: Metadata = { title: 'Awaiting approval' };
export const dynamic = 'force-dynamic';

/** Where signed-in accounts land until an administrator approves them. */
export default async function PendingApprovalPage() {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  if (!user.emailVerified) redirect('/login?notice=verify');
  if (user.accountStatus !== 'pending_approval' && user.accountStatus !== 'rejected' && user.accountStatus !== null) redirect('/dashboard');
  const rejected = user.accountStatus === 'rejected';
  return (
    <Card>
      <h1 className="mb-1 text-xl font-semibold">{rejected ? 'Registration not approved' : 'Awaiting approval'}</h1>
      <p className="mb-6 text-sm text-fg-muted">Signed in as {user.email}</p>
      {rejected ? (
        <Notice tone="danger" title="Your registration was not approved">
          An administrator reviewed this account and did not approve it. Contact support if you think this is a mistake.
        </Notice>
      ) : (
        <Notice tone="info" title="Your account is being reviewed">
          Your email is verified. An administrator approves every new account before it can be used. Check back here later; this page updates when you reload it.
        </Notice>
      )}
      <div className="mt-6 flex justify-end">
        <SignOutButton />
      </div>
    </Card>
  );
}
