import type { Metadata } from 'next';
import Link from 'next/link';
import { webDb } from '@/server/db';
import { adminUsers } from '@/server/queries/admin';
import { Badge, Card, CardHeader, EmptyState, Input, PageHeader, Table, Td, Mono } from '@/components/ui/primitives';
import { AddMemberForm } from '@/components/admin/add-member-form';
import { pageStaff } from '@/server/http/auth';
import { can } from '@/server/permissions';
import { maybeOne } from '@/server/db-core';
import { Money } from '@/components/ui/money';
import { KycStatus } from '@/components/ui/status';
import { dateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Users' };

export default async function AdminUsersPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  const staff = await pageStaff();
  const db = webDb();
  const [users, me] = await Promise.all([
    adminUsers(db, q?.trim().slice(0, 100) || null),
    maybeOne<{ member_code: string }>(db, 'select member_code from public.user_profiles where user_id = $1', [staff.id]),
  ]);
  return (
    <>
      <PageHeader title="Users" />
      {can(staff.roles, 'network.manage') ? (
        <Card className="mb-6">
          <CardHeader
            title="Add a member"
            subtitle="Create an account directly, with its sponsor and team position. Any position can be used; the member who holds it moves down under the new one."
          />
          <AddMemberForm defaultSponsor={me?.member_code ?? ''} />
        </Card>
      ) : null}
      <Card>
        <form className="mb-4 max-w-md">
          <label htmlFor="q" className="sr-only">Search users</label>
          <Input id="q" name="q" defaultValue={q} placeholder="Search by email, member id or user id" />
        </form>
        <Table head={['Email', 'Member', 'Sponsor', 'User id', 'KYC', 'Status', 'Available', 'Roles', 'Joined']} empty={users.length ? null : <EmptyState title="No users found" />}>
          {users.map((u) => (
            <tr key={u.user_id}>
              <Td><Link className="text-accent hover:underline" href={`/admin/users/${u.user_id}`}>{u.email}</Link></Td>
              <Td><Mono>{u.member_code}</Mono></Td>
              <Td>{u.sponsor_code ? <Mono>{u.sponsor_code}</Mono> : <span className="text-fg-muted">—</span>}</Td>
              <Td><Mono>{u.user_id.slice(0, 8)}</Mono></Td>
              <Td><KycStatus status={u.kyc ?? 'not_started'} /></Td>
              <Td><Badge tone={u.account_status === 'active' ? 'success' : u.account_status === 'pending_approval' ? 'warn' : 'danger'}>{u.account_status.replace('_', ' ')}</Badge></Td>
              <Td><Money value={u.cash} decimals={6} /></Td>
              <Td className="text-xs text-fg-muted">{u.roles?.join(', ') ?? ''}</Td>
              <Td className="text-fg-muted">{dateTime(u.created_at)}</Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
