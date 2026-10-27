import type { Metadata } from 'next';
import Link from 'next/link';
import { webDb } from '@/server/db';
import { pageStaff } from '@/server/http/auth';
import { can } from '@/server/permissions';
import { listHolders, MICRO_DECIMALS } from '@/server/offchain/holdings';
import { Card, CardHeader, EmptyState, Mono, Notice, PageHeader, Table, Td } from '@/components/ui/primitives';
import { Money } from '@/components/ui/money';
import { Stat } from '@/components/app/stat';
import { CreateHolderForm } from '@/components/admin/offchain-forms';
import { dateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Off-platform ledger' };
export const dynamic = 'force-dynamic';

export default async function OffPlatformPage() {
  const staff = await pageStaff();
  const holders = await listHolders(webDb());
  const total = holders.reduce((s, h) => s + BigInt(h.balance), 0n);
  return (
    <>
      <PageHeader
        title="Off-platform ledger"
        description="Money people handed you personally, outside the group wallet. Kept separate from on-chain balances and not withdrawable on the site. To make part of it withdrawable, send it to the group wallet, assign the receipt to the member, then match it here."
      />
      <div className="grid gap-6 md:grid-cols-3">
        <Stat label="Held off-platform" value={<Money value={total} decimals={MICRO_DECIMALS} symbol="USDT" />} />
        <Stat label="People" value={holders.length} />
        <Stat label="Linked to accounts" value={holders.filter((h) => h.user_id).length} />
      </div>
      <Card className="mt-6">
        <CardHeader title="Add a person" subtitle="Record them by name; link their account later if they sign up." />
        {can(staff.roles, 'offchain.record') ? <CreateHolderForm /> : <Notice tone="info">Only administrators can change the off-platform ledger.</Notice>}
      </Card>
      <Card className="mt-6">
        <CardHeader title={`People (${holders.length})`} />
        <Table head={['Name', 'Account', 'Balance', 'Entries', 'Last entry']} empty={holders.length ? null : <EmptyState title="Nobody recorded yet" />}>
          {holders.map((h) => (
            <tr key={h.id}>
              <Td>
                <Link className="text-accent hover:underline" href={`/admin/off-platform/${h.id}`}>{h.name}</Link>
              </Td>
              <Td>{h.member_code ? <Mono>{h.member_code}</Mono> : <span className="text-fg-muted">Not linked</span>}</Td>
              <Td><Money value={h.balance} decimals={MICRO_DECIMALS} /></Td>
              <Td>{h.entries}</Td>
              <Td className="text-fg-muted">{h.last_entry ? dateTime(h.last_entry) : '—'}</Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
