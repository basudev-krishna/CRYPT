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
import { dateTime } from '@/lib/format';
import { MICRO_DECIMALS, unlinkedHolders } from '@/server/offchain/holdings';

export const metadata: Metadata = { title: 'Users' };

export default async function AdminUsersPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  const staff = await pageStaff();
  const db = webDb();
  const [users, me, unlinked] = await Promise.all([
    adminUsers(db, q?.trim().slice(0, 100) || null),
    maybeOne<{ member_code: string }>(db, 'select member_code from public.user_profiles where user_id = $1', [staff.id]),
    unlinkedHolders(db),
  ]);
  return (
    <>
      <PageHeader title="Users" description="Click Manage on a member to edit their details, balance, rewards and prizes, off-platform money, team position and ranks." />
      {can(staff.roles, 'network.manage') ? (
        <Card className="mb-6">
          <CardHeader
            title="Add a member"
            subtitle="Create their login (username, email and a starting password) with its sponsor and team position. They can change the password later under Security. Any position can be used; the member who holds it moves down under the new one."
          />
          <AddMemberForm defaultSponsor={me?.member_code ?? ''} />
        </Card>
      ) : null}
      {unlinked.length ? (
        <Card className="mb-6">
          <CardHeader
            title={`Off-platform records without an account (${unlinked.length})`}
            subtitle="People recorded by name before they had a login. Create their account above, then open the record and link it; it then shows on their user page."
          />
          <Table head={['Name', 'Held off-platform', 'Entries', 'Last entry']}>
            {unlinked.map((h) => (
              <tr key={h.id}>
                <Td><Link className="text-accent hover:underline" href={`/admin/off-platform/${h.id}`}>{h.name}</Link></Td>
                <Td><Money value={h.balance} decimals={MICRO_DECIMALS} /></Td>
                <Td>{h.entries}</Td>
                <Td className="text-fg-muted">{h.last_entry ? dateTime(h.last_entry) : '—'}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      ) : null}
      <Card>
        <form className="mb-4 max-w-md">
          <label htmlFor="q" className="sr-only">Search users</label>
          <Input id="q" name="q" defaultValue={q} placeholder="Search by email, member id or user id" />
        </form>
        <Table head={['', 'Email', 'Member', 'Sponsor', 'User id', 'Status', 'Available', 'Roles', 'Joined']} empty={users.length ? null : <EmptyState title="No users found" />}>
          {users.map((u) => (
            <tr key={u.user_id}>
              <Td>
                <Link
                  className="inline-flex h-8 items-center rounded-lg border border-line px-3 text-xs font-medium text-accent hover:bg-accent/5"
                  href={`/admin/users/${u.user_id}`}
                >
                  Manage
                </Link>
              </Td>
              <Td><Link className="text-accent hover:underline" href={`/admin/users/${u.user_id}`}>{u.email}</Link></Td>
              <Td><Mono>{u.member_code}</Mono></Td>
              <Td>{u.sponsor_code ? <Mono>{u.sponsor_code}</Mono> : <span className="text-fg-muted">—</span>}</Td>
              <Td><Mono>{u.user_id.slice(0, 8)}</Mono></Td>
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
