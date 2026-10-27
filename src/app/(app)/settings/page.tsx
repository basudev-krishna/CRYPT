import type { Metadata } from 'next';
import Link from 'next/link';
import { pageUser } from '@/server/http/auth';
import { webDb } from '@/server/db';
import { getMembership, getProfile } from '@/server/queries/user';
import { Card, CardHeader, Mono, PageHeader } from '@/components/ui/primitives';
import { ProfileForm } from '@/components/app/actions';

export const metadata: Metadata = { title: 'Profile' };

export default async function SettingsPage() {
  const user = await pageUser();
  const [profile, membership] = await Promise.all([getProfile(webDb(), user.id), getMembership(webDb(), user.id)]);
  return (
    <>
      <PageHeader title="Profile" />
      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title="Profile" subtitle={user.email} />
          <ProfileForm displayName={profile?.displayName ?? null} countryCode={profile?.countryCode ?? null} />
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
