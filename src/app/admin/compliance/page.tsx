import type { Metadata } from 'next';
import Link from 'next/link';
import { webDb } from '@/server/db';
import { adminKycQueue, adminRiskEvents } from '@/server/queries/admin';
import { Badge, Card, CardHeader, EmptyState, PageHeader, Table, Td } from '@/components/ui/primitives';
import { NoteAction } from '@/components/app/actions';
import { JsonBlock } from '@/components/admin/json';
import { dateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Compliance review' };

export default async function AdminCompliancePage() {
  const db = webDb();
  const [kyc, risk] = await Promise.all([adminKycQueue(db), adminRiskEvents(db)]);
  return (
    <>
      <PageHeader title="Compliance review" description="KYC queue and open risk events. Every decision requires a documented note and is recorded in the audit log." />
      <Card>
        <CardHeader title={`KYC queue (${kyc.length})`} />
        <Table head={['Submitted', 'User', 'Name', 'Country', 'Document', 'Decision']} empty={kyc.length ? null : <EmptyState title="Nothing to review" />}>
          {kyc.map((k) => (
            <tr key={k.id}>
              <Td className="whitespace-nowrap text-fg-muted">{dateTime(k.submitted_at)}</Td>
              <Td className="text-xs"><Link className="text-accent hover:underline" href={`/admin/users/${k.user_id}`}>{k.email}</Link></Td>
              <Td>{k.full_name}</Td>
              <Td>{k.country_code}</Td>
              <Td className="text-xs">{k.document_type} ···{k.document_last4}</Td>
              <Td className="w-72"><NoteAction url={`/api/admin/kyc/${k.id}/review`} options={[{ value: 'approve', label: 'Approve', field: 'decision' }, { value: 'reject', label: 'Reject', field: 'decision' }]} noteLabel="Review note" /></Td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card className="mt-6">
        <CardHeader title={`Open risk events (${risk.length})`} />
        <Table head={['When', 'Kind', 'Severity', 'Subject', 'Status', 'Details', 'Resolve']} empty={risk.length ? null : <EmptyState title="No open risk events" />}>
          {risk.map((r) => (
            <tr key={r.id}>
              <Td className="whitespace-nowrap text-fg-muted">{dateTime(r.created_at)}</Td>
              <Td>{r.kind}</Td>
              <Td><Badge tone={r.severity === 'critical' || r.severity === 'high' ? 'danger' : r.severity === 'medium' ? 'warn' : 'neutral'}>{r.severity}</Badge></Td>
              <Td className="text-xs">{r.subject_type} {r.subject_id.slice(0, 12)}</Td>
              <Td>{r.status}</Td>
              <Td><JsonBlock value={r.details} /></Td>
              <Td className="w-64"><NoteAction url={`/api/admin/risk-events/${r.id}/resolve`} options={[{ value: 'resolved', label: 'Resolve', field: 'status' }, { value: 'acknowledged', label: 'Acknowledge', field: 'status' }]} noteLabel="Resolution note" /></Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
