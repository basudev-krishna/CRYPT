import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { webDb } from '@/server/db';
import { pageStaff } from '@/server/http/auth';
import { can } from '@/server/permissions';
import { getHolder } from '@/server/offchain/holdings';
import { PageHeader } from '@/components/ui/primitives';
import { OffchainSection } from '@/components/admin/offchain-section';

export const metadata: Metadata = { title: 'Off-platform record' };
export const dynamic = 'force-dynamic';

/**
 * A record kept by name before the person had an account. Once linked, it is
 * shown on the member's user page instead.
 */
export default async function HolderPage({ params }: { params: Promise<{ id: string }> }) {
  const staff = await pageStaff();
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();
  const db = webDb();
  const holder = await getHolder(db, id.data);
  if (!holder) notFound();
  if (holder.user_id) redirect(`/admin/users/${holder.user_id}`);
  return (
    <>
      <PageHeader
        title={holder.name}
        description={
          <>
            <Link className="text-accent hover:underline" href="/admin/users">← Users</Link> · Not linked to an account yet. Create their login on the Users page, then link it here.
          </>
        }
      />
      <OffchainSection db={db} holder={holder} canRecord={can(staff.roles, 'offchain.record')} />
    </>
  );
}
