import type { Metadata } from 'next';
import { webDb } from '@/server/db';
import { pageStaff } from '@/server/http/auth';
import { can } from '@/server/permissions';
import { adminInvitations } from '@/server/queries/admin';
import { Badge, Card, CardHeader, EmptyState, Mono, Notice, PageHeader, Table, Td } from '@/components/ui/primitives';
import { NoteAction } from '@/components/app/actions';
import { InviteForm } from '@/components/admin/invite-form';
import { dateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Invitations' };

export default async function AdminMembersPage() {
  const staff = await pageStaff();
  const canInvite = can(staff.roles, 'member.invite');
  const invitations = await adminInvitations(webDb());
  return (
    <>
      <PageHeader
        title="Invitations"
        description="Membership is by invitation only. Each invitation is for one email address, works once, and is recorded in the audit log."
      />
      <Card>
        <CardHeader title="Invite a member" />
        {canInvite ? <InviteForm /> : <Notice tone="info">Only administrators can issue invitations.</Notice>}
      </Card>
      <Card className="mt-6">
        <CardHeader title={`Invitations (${invitations.length})`} />
        <Table head={['Issued', 'Email', 'Sponsor', 'Status', 'Expires', 'Member', 'Reason', 'Issued by', canInvite ? 'Revoke' : '']} empty={invitations.length ? null : <EmptyState title="No invitations yet" />}>
          {invitations.map((i) => (
            <tr key={i.id}>
              <Td className="whitespace-nowrap text-fg-muted">{dateTime(i.created_at)}</Td>
              <Td className="text-xs">{i.email}</Td>
              <Td>{i.sponsor_code ? <Mono>{i.sponsor_code}</Mono> : <span className="text-fg-muted">—</span>}</Td>
              <Td>
                {i.expired ? (
                  <Badge tone="neutral">expired</Badge>
                ) : (
                  <Badge tone={i.status === 'accepted' ? 'success' : i.status === 'revoked' ? 'danger' : 'warn'} title={i.revoke_reason ?? undefined}>{i.status}</Badge>
                )}
              </Td>
              <Td className="whitespace-nowrap text-fg-muted">{dateTime(i.expires_at)}</Td>
              <Td>{i.member_code ? <Mono>{i.member_code}</Mono> : <span className="text-fg-muted">—</span>}</Td>
              <Td className="max-w-xs text-xs text-fg-muted">{i.note}</Td>
              <Td className="text-xs text-fg-muted">{i.created_by}</Td>
              <Td className="w-64">
                {canInvite && i.status === 'pending' ? <NoteAction url={`/api/admin/invitations/${i.id}/revoke`} noteField="reason" noteLabel="Revoke reason" submitLabel="Revoke" /> : null}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
