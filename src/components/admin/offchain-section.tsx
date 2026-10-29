import type { Db } from '@/server/db-core';
import { listEntries, MICRO_DECIMALS, offchainBalance, unmatchedAssignments } from '@/server/offchain/holdings';
import { Card, CardHeader, EmptyState, Notice, Table, Td } from '@/components/ui/primitives';
import { Money } from '@/components/ui/money';
import { OffchainKind } from '@/components/ui/offchain';
import { NoteAction } from '@/components/app/actions';
import { EditHolderForm, EntryForm, LinkHolderForm, MoveToPlatformForm } from '@/components/admin/offchain-forms';
import { dateTime } from '@/lib/format';

/**
 * A person's off-platform record (money handed to the administrator
 * personally): balance, entry form, matching to the platform, and history.
 * Shown on the member's user page; the record stays a separate memo ledger.
 */
export async function OffchainSection({
  db,
  holder,
  canRecord,
  showEntryForm = true,
}: {
  db: Db;
  holder: { id: string; name: string; note: string | null; user_id: string | null };
  canRecord: boolean;
  /** Off on the user page, where the balance form at the top records entries. */
  showEntryForm?: boolean;
}) {
  const [balance, entries, assignments] = await Promise.all([
    offchainBalance(db, holder.id),
    listEntries(db, holder.id),
    holder.user_id ? unmatchedAssignments(db, holder.user_id) : Promise.resolve([]),
  ]);
  const total = (kind: string) => entries.filter((e) => e.kind === kind).reduce((s, e) => s + e.amountMicro, 0n);
  return (
    <Card>
      <CardHeader
        title="Off-platform money"
        subtitle="Money handed to you personally, outside the group wallet. Kept apart from the platform balance and not withdrawable on the site; the member sees it on their Off-platform page."
      />
      <dl className="mb-5 grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
        <div>
          <dt className="text-fg-muted">Held off-platform</dt>
          <dd className="text-base font-semibold"><Money value={balance} decimals={MICRO_DECIMALS} symbol="USDT" /></dd>
        </div>
        <div>
          <dt className="text-fg-muted">Received</dt>
          <dd><Money value={total('contribution')} decimals={MICRO_DECIMALS} /></dd>
        </div>
        <div>
          <dt className="text-fg-muted">Earnings</dt>
          <dd><Money value={total('earnings')} decimals={MICRO_DECIMALS} /></dd>
        </div>
        <div>
          <dt className="text-fg-muted">Paid back</dt>
          <dd><Money value={-total('payback')} decimals={MICRO_DECIMALS} /></dd>
        </div>
      </dl>
      {canRecord ? (
        <div className="grid gap-6 xl:grid-cols-2">
          {showEntryForm ? (
            <div>
              <h3 className="mb-3 text-sm font-medium">Record an entry</h3>
              <EntryForm holderId={holder.id} />
            </div>
          ) : null}
          <div>
            {holder.user_id ? (
              <>
                <h3 className="mb-1 text-sm font-medium">Move to platform</h3>
                <p className="mb-3 text-xs text-fg-muted">Makes part of it withdrawable: assign their group-wallet receipt, then match it here.</p>
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
                <h3 className="mb-3 text-sm font-medium">Link their account</h3>
                <LinkHolderForm holderId={holder.id} />
              </>
            )}
            <div className="mt-6 border-t border-line pt-4">
              <EditHolderForm holderId={holder.id} name={holder.name} note={holder.note} />
            </div>
          </div>
        </div>
      ) : (
        <Notice tone="info">Only administrators can change off-platform records.</Notice>
      )}
      <div className="mt-6">
        <Table head={['Date', 'Type', 'Amount', 'Reason', 'Recorded', canRecord ? 'Correct' : '']} empty={entries.length ? null : <EmptyState title="No entries yet" />}>
          {entries.map((e) => (
            <tr key={e.id}>
              <Td className="text-fg-muted">{e.occurredOn}</Td>
              <Td><OffchainKind kind={e.kind} category={e.category} /></Td>
              <Td><Money value={e.amountMicro} decimals={MICRO_DECIMALS} signed colored /></Td>
              <Td className="max-w-md">
                {e.reason}
                {e.reversesEntryId ? <span className="block text-xs text-fg-muted">Reverses entry #{e.reversesEntryId}</span> : null}
                {e.reversed ? <span className="block text-xs text-loss">Reversed</span> : null}
              </Td>
              <Td className="text-fg-muted">#{e.id} · {dateTime(e.createdAt)}</Td>
              <Td className="min-w-56">
                {canRecord && !e.reversed && e.kind !== 'reversal' && e.kind !== 'moved_to_platform' ? (
                  <NoteAction url={`/api/admin/offchain/entries/${e.id}/reverse`} noteField="reason" noteLabel="Why reverse it?" submitLabel="Reverse" />
                ) : null}
              </Td>
            </tr>
          ))}
        </Table>
      </div>
    </Card>
  );
}
