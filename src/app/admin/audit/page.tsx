import type { Metadata } from 'next';
import { webDb } from '@/server/db';
import { adminAuditEvents, adminPolicies } from '@/server/queries/admin';
import { Card, CardHeader, EmptyState, Input, Mono, PageHeader, Table, Td } from '@/components/ui/primitives';
import { JsonBlock } from '@/components/admin/json';
import { dateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Audit log' };

export default async function AdminAuditPage({ searchParams }: { searchParams: Promise<{ actor?: string; action?: string }> }) {
  const { actor, action } = await searchParams;
  const db = webDb();
  const [events, policies] = await Promise.all([adminAuditEvents(db, { actor: actor?.trim() || null, action: action?.trim() || null }), adminPolicies(db)]);
  return (
    <>
      <PageHeader title="Audit log & policies" description="Append-only record of sensitive actions. Policies are versioned; changes create new versions, never edits." />
      <Card>
        <form className="mb-4 flex flex-wrap gap-3">
          <Input name="actor" defaultValue={actor} placeholder="Actor id" className="max-w-xs" aria-label="Filter by actor id" />
          <Input name="action" defaultValue={action} placeholder="Action prefix, e.g. withdrawal." className="max-w-xs" aria-label="Filter by action prefix" />
          <button className="rounded-lg border border-line px-4 text-sm hover:border-accent">Filter</button>
        </form>
        <Table head={['When', 'Actor', 'Action', 'Subject', 'IP', 'Details']} empty={events.length ? null : <EmptyState title="No events" />}>
          {events.map((e) => (
            <tr key={e.id}>
              <Td className="whitespace-nowrap text-fg-muted">{dateTime(e.created_at)}</Td>
              <Td className="text-xs">{e.actor_type}:<Mono>{e.actor_id.slice(0, 12)}</Mono></Td>
              <Td className="text-xs">{e.action}</Td>
              <Td className="text-xs">{e.subject_type} <Mono>{e.subject_id?.slice(0, 14)}</Mono></Td>
              <Td><Mono>{e.ip ?? ''}</Mono></Td>
              <Td><JsonBlock value={e.details} /></Td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card className="mt-6">
        <CardHeader title="Policy versions" />
        <Table head={['Kind', 'Version', 'Effective', 'Note', 'By / approved', 'Params']}>
          {policies.map((p) => (
            <tr key={p.id}>
              <Td>{p.kind}</Td><Td className="num">v{p.version}</Td><Td className="text-fg-muted">{dateTime(p.effective_from)}</Td>
              <Td className="max-w-xs text-xs text-fg-muted">{p.change_note}</Td><Td className="text-xs">{p.created_by} / {p.approved_by ?? '—'}</Td>
              <Td><JsonBlock value={p.params} /></Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
