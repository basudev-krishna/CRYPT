import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { webDb } from '@/server/db';
import { pageStaff } from '@/server/http/auth';
import { can } from '@/server/permissions';
import { getHolder, listEntries, MICRO_DECIMALS, offchainBalance, unmatchedAssignments } from '@/server/offchain/holdings';
import { Card, CardHeader, EmptyState, Mono, Notice, PageHeader, Table, Td } from '@/components/ui/primitives';
import { Money } from '@/components/ui/money';
import { OffchainKind } from '@/components/ui/offchain';
import { Stat } from '@/components/app/stat';
import { NoteAction } from '@/components/app/actions';
import { EditHolderForm, EntryForm, LinkHolderForm, MoveToPlatformForm } from '@/components/admin/offchain-forms';
import { dateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Off-platform holder' };
export const dynamic = 'force-dynamic';

export default async function HolderPage({ params }: { params: Promise<{ id: string }> }) {
  const staff = await pageStaff();
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();
  const db = webDb();
  const holder = await getHolder(db, id.data);
  if (!holder) notFound();
  const [balance, entries, assignments] = await Promise.all([
    offchainBalance(db, holder.id),
    listEntries(db, holder.id),
    holder.user_id ? unmatchedAssignments(db, holder.user_id) : Promise.resolve([]),
  ]);
  const canRecord = can(staff.roles, 'offchain.record');
  const total = (kind: string) => entries.filter((e) => e.kind === kind).reduce((s, e) => s + e.amountMicro, 0n);
  return (
    <>
      <PageHeader
        title={holder.name}
        description={<Link className="text-accent hover:underline" href="/admin/off-platform">← Off-platform ledger</Link>}
      />
      <div className="grid gap-6 md:grid-cols-4">
        <Stat label="Balance held off-platform" value={<Money value={balance} decimals={MICRO_DECIMALS} symbol="USDT" />} emphasis />
        <Stat label="Received" value={<Money value={total('contribution')} decimals={MICRO_DECIMALS} />} />
        <Stat label="Earnings" value={<Money value={total('earnings')} decimals={MICRO_DECIMALS} />} />
        <Stat
          label="Account"
          value={holder.member_code ? <Mono>{holder.member_code}</Mono> : 'Not linked'}
          sub={holder.linked_at ? `Linked ${dateTime(holder.linked_at)}` : undefined}
        />
      </div>

      {canRecord ? (
        <div className="mt-6 grid gap-6 xl:grid-cols-2">
          <Card>
            <CardHeader title="Record an entry" subtitle="Every entry is permanent, audited and alerted. Fix mistakes by reversing the entry." />
            <EntryForm holderId={holder.id} />
          </Card>
          <Card>
            {holder.user_id ? (
              <>
                <CardHeader title="Move to platform" subtitle="Makes part of the balance withdrawable on the site." />
                <MoveToPlatformForm
                  holderId={holder.id}
                  assignments={assignments.map((a) => ({
                    id: a.id,
                    amountBase: a.amount_base,
                    decimals: Number(a.decimals),
                    symbol: a.symbol,
                    postedAt: new Date(a.posted_at).toISOString(),
                  }))}
                />
              </>
            ) : (
              <>
                <CardHeader title="Link their account" subtitle="Needed before they can see this or move money on the platform." />
                <LinkHolderForm holderId={holder.id} />
              </>
            )}
            <div className="mt-6 border-t border-line pt-4">
              <EditHolderForm holderId={holder.id} name={holder.name} note={holder.note} />
            </div>
          </Card>
        </div>
      ) : (
        <div className="mt-6">
          <Notice tone="info">Only administrators can change the off-platform ledger.</Notice>
        </div>
      )}

      <Card className="mt-6">
        <CardHeader title={`Entries (${entries.length})`} />
        <Table head={['Date', 'Type', 'Amount', 'Reason', 'Recorded', canRecord ? 'Correct' : '']} empty={entries.length ? null : <EmptyState title="No entries yet" />}>
          {entries.map((e) => (
            <tr key={e.id}>
              <Td className="text-fg-muted">{e.occurredOn}</Td>
              <Td><OffchainKind kind={e.kind} /></Td>
              <Td><Money value={e.amountMicro} decimals={MICRO_DECIMALS} signed colored /></Td>
              <Td className="max-w-md">
                {e.reason}
                {e.reversesEntryId ? <span className="block text-xs text-fg-muted">Reverses entry #{e.reversesEntryId}</span> : null}
                {e.reversed ? <span className="block text-xs text-loss">Reversed</span> : null}
              </Td>
              <Td className="text-fg-muted">
                #{e.id} · {dateTime(e.createdAt)}
              </Td>
              <Td className="min-w-56">
                {canRecord && !e.reversed && e.kind !== 'reversal' && e.kind !== 'moved_to_platform' ? (
                  <NoteAction url={`/api/admin/offchain/entries/${e.id}/reverse`} noteField="reason" noteLabel="Why reverse it?" submitLabel="Reverse" />
                ) : null}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
