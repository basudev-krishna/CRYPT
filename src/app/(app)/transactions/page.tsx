import type { Metadata } from 'next';
import Link from 'next/link';
import { pageUser } from '@/server/http/auth';
import { webDb } from '@/server/db';
import { listActiveTokens, listActivity } from '@/server/queries/user';
import { memberHolding, microToBase } from '@/server/offchain/holdings';
import { maybeOne } from '@/server/db-core';
import { heldLabel } from '@/components/ui/offchain';
import { Card, EmptyState, Mono, PageHeader, Table, Td } from '@/components/ui/primitives';
import { Money } from '@/components/ui/money';
import { EVENT_LABELS } from '@/components/ui/status';
import { dateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Transactions' };

export default async function TransactionsPage({ searchParams }: { searchParams: Promise<{ before?: string }> }) {
  const user = await pageUser();
  const { before } = await searchParams;
  const db = webDb();
  const cursor = before && /^\d+$/.test(before) ? before : undefined;
  const [items, tokens, holding, upper] = await Promise.all([
    listActivity(db, user.id, 50, cursor),
    listActiveTokens(db),
    memberHolding(db, user.id),
    cursor ? maybeOne<{ posted_at: Date }>(db, 'select posted_at from public.journal_entries where id = $1', [cursor]) : Promise.resolve(null),
  ]);
  const dec = tokens[0]?.decimals ?? 6;
  // Entries the administrator recorded, shown in the same date window as this page of ledger entries.
  const full = items.length === 50;
  const lowerAt = full ? new Date(items[items.length - 1]!.postedAt).getTime() : -Infinity;
  const upperAt = upper ? new Date(upper.posted_at).getTime() : Infinity;
  const rows = [
    ...items.map((a) => ({
      key: `l:${a.entryId}`,
      at: new Date(a.postedAt),
      label: EVENT_LABELS[a.eventType] ?? a.eventType,
      description: a.description,
      cash: a.cashDelta,
      pending: a.pendingDelta,
      reserved: a.reservedDelta,
      ref: `#${a.entryId}`,
    })),
    ...(holding?.entries ?? [])
      .filter((e) => {
        const t = new Date(e.createdAt).getTime();
        return t >= lowerAt && t < upperAt;
      })
      .map((e) => ({
        key: `h:${e.id}`,
        at: new Date(e.createdAt),
        label: heldLabel(e),
        description: e.reason,
        cash: microToBase(e.amountMicro, dec),
        pending: 0n,
        reserved: 0n,
        ref: 'By administrator',
      })),
  ].sort((x, y) => y.at.getTime() - x.at.getTime());
  return (
    <>
      <PageHeader title="Transactions" description="Every entry affecting your account, including deposits, rewards and balance changes recorded by the administrator. Entries are immutable; corrections appear as separate entries." />
      <Card>
        <Table head={['Date', 'Event', 'Description', 'Amount', 'Pending investment', 'Reserved', 'Entry']} empty={rows.length ? null : <EmptyState title="No transactions yet" />}>
          {rows.map((a) => (
            <tr key={a.key}>
              <Td className="whitespace-nowrap text-fg-muted">{dateTime(a.at)}</Td>
              <Td>{a.label}</Td>
              <Td className="max-w-xs truncate text-fg-muted" title={a.description}>{a.description}</Td>
              <Td>{a.cash !== 0n ? <Money value={a.cash} decimals={dec} signed colored /> : ''}</Td>
              <Td>{a.pending !== 0n ? <Money value={a.pending} decimals={dec} signed /> : ''}</Td>
              <Td>{a.reserved !== 0n ? <Money value={a.reserved} decimals={dec} signed /> : ''}</Td>
              <Td><Mono>{a.ref}</Mono></Td>
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
