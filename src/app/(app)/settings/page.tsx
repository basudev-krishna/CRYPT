import type { Metadata } from 'next';
import Link from 'next/link';
import { pageUser } from '@/server/http/auth';
import { webDb } from '@/server/db';
import { getMembership, getProfile } from '@/server/queries/user';
import { Card, CardHeader, Mono, Notice, PageHeader } from '@/components/ui/primitives';
import { KycStatus } from '@/components/ui/status';
import { KycForm, ProfileForm } from '@/components/app/actions';

export const metadata: Metadata = { title: 'Profile & verification' };

export default async function SettingsPage() {
  const user = await pageUser();
  const [profile, membership] = await Promise.all([getProfile(webDb(), user.id), getMembership(webDb(), user.id)]);
  const kyc = profile?.kycStatus ?? 'not_started';
  return (
    <>
      <PageHeader title="Profile & verification" />
      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title="Profile" subtitle={user.email} />
          <ProfileForm displayName={profile?.displayName ?? null} countryCode={profile?.countryCode ?? null} />
        </Card>
        <Card>
          <CardHeader title="Identity verification (KYC)" action={<KycStatus status={kyc} />} />
          {kyc === 'approved' ? <Notice tone="success">Your identity is verified.</Notice> : null}
          {kyc === 'pending' ? <Notice tone="warn">Your submission is with the compliance team for review.</Notice> : null}
          {kyc === 'not_started' || kyc === 'rejected' || kyc === 'expired' ? (
            <div className="space-y-4">
              {kyc === 'rejected' ? <Notice tone="danger">Your previous submission was rejected. You may submit again with corrected details.</Notice> : null}
              <p className="text-sm text-fg-muted">
                Testnet build: details go to a manual review queue. A production deployment must use a regulated KYC provider with document and liveness checks.
              </p>
              <KycForm />
            </div>
          ) : null}
        </Card>
        {membership ? (
          <Card>
            <CardHeader title="Membership" subtitle="New accounts are approved by an administrator." />
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              <dt className="text-fg-muted">Member id</dt>
              <dd><Mono>{membership.memberCode}</Mono></dd>
              <dt className="text-fg-muted">Referred by</dt>
              <dd>{membership.sponsorMemberCode ? <Mono>{membership.sponsorMemberCode}</Mono> : <span className="text-fg-muted">None</span>}</dd>
              <dt className="text-fg-muted">Members you referred</dt>
              <dd>
                {membership.sponsored.length} ·{' '}
                <Link className="text-accent hover:underline" href="/referrals">Referrals and your link</Link>
              </dd>
            </dl>
          </Card>
        ) : null}
      </div>
    </>
  );
}
