import type { Metadata } from 'next';
import Link from 'next/link';
import { pageUser } from '@/server/http/auth';
import { webDb } from '@/server/db';
import { listActiveTokens, listActivity } from '@/server/queries/user';
import { Card, EmptyState, Mono, PageHeader, Table, Td } from '@/components/ui/primitives';
import { Money } from '@/components/ui/money';
import { EVENT_LABELS } from '@/components/ui/status';
import { dateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Transactions' };

export default async function TransactionsPage({ searchParams }: { searchParams: Promise<{ before?: string }> }) {
  const user = await pageUser();
  const { before } = await searchParams;
  const db = webDb();
  const [items, tokens] = await Promise.all([listActivity(db, user.id, 50, before && /^\d+$/.test(before) ? before : undefined), listActiveTokens(db)]);
  const dec = tokens[0]?.decimals ?? 6;
  return (
    <>
      <PageHeader title="Transactions" description="Every ledger entry affecting your account. Entries are immutable; corrections appear as separate reversal entries." />
      <Card>
        <Table head={['Date', 'Event', 'Description', 'Available', 'Pending investment', 'Reserved', 'Entry']} empty={items.length ? null : <EmptyState title="No transactions yet" />}>
          {items.map((a) => (
            <tr key={a.entryId}>
              <Td className="whitespace-nowrap text-fg-muted">{dateTime(a.postedAt)}</Td>
              <Td>{EVENT_LABELS[a.eventType] ?? a.eventType}</Td>
              <Td className="max-w-xs truncate text-fg-muted" title={a.description}>{a.description}</Td>
              <Td>{a.cashDelta !== 0n ? <Money value={a.cashDelta} decimals={dec} signed colored /> : ''}</Td>
              <Td>{a.pendingDelta !== 0n ? <Money value={a.pendingDelta} decimals={dec} signed /> : ''}</Td>
              <Td>{a.reservedDelta !== 0n ? <Money value={a.reservedDelta} decimals={dec} signed /> : ''}</Td>
              <Td><Mono>#{a.entryId}</Mono></Td>
            </tr>
          ))}
        </Table>
        {items.length === 50 ? (
          <div className="mt-4 text-right">
            <Link className="text-sm text-accent hover:underline" href={`/transactions?before=${items[items.length - 1]?.entryId}`}>Older →</Link>
          </div>
        ) : null}
      </Card>
    </>
  );
}
