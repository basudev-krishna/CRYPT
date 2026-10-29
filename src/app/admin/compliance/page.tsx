import type { Metadata } from 'next';
import { webDb } from '@/server/db';
import { adminRiskEvents } from '@/server/queries/admin';
import { Badge, Card, CardHeader, EmptyState, PageHeader, Table, Td } from '@/components/ui/primitives';
import { NoteAction } from '@/components/app/actions';
import { JsonBlock } from '@/components/admin/json';
import { dateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Compliance review' };

export default async function AdminCompliancePage() {
  const db = webDb();
  const risk = await adminRiskEvents(db);
  return (
    <>
      <PageHeader title="Compliance review" description="Open risk events. Every decision requires a documented note and is recorded in the audit log." />
      <Card>
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
