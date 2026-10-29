import type { Metadata } from 'next';
import { pageUser } from '@/server/http/auth';
import { webDb } from '@/server/db';
import { MICRO_DECIMALS, memberHolding } from '@/server/offchain/holdings';
import { Card, CardHeader, EmptyState, Notice, PageHeader, Table, Td } from '@/components/ui/primitives';
import { Money } from '@/components/ui/money';
import { OffchainKind } from '@/components/ui/offchain';
import { Stat } from '@/components/app/stat';

export const metadata: Metadata = { title: 'Held off-platform' };

export default async function OffPlatformMemberPage() {
  const user = await pageUser();
  const holding = await memberHolding(webDb(), user.id);
  if (!holding) {
    return (
      <>
        <PageHeader title="Held off-platform" />
        <EmptyState title="Nothing recorded">If you handed money to the administrator directly, ask them to link the record to your account.</EmptyState>
      </>
    );
  }
  const earnings = holding.entries.filter((e) => e.kind === 'earnings').reduce((s, e) => s + e.amountMicro, 0n);
  return (
    <>
      <PageHeader
        title="Held off-platform"
        description="Money you handed the administrator directly, recorded by them. It is not in the group wallet, so it is not part of your available balance and cannot be withdrawn on the site."
      />
      <div className="grid gap-6 md:grid-cols-2">
        <Stat label="Balance held for you" value={<Money value={holding.balance} decimals={MICRO_DECIMALS} symbol="USDT" />} emphasis />
        <Stat label="Recorded earnings" value={<Money value={earnings} decimals={MICRO_DECIMALS} symbol="USDT" />} />
      </div>
      <div className="mt-6">
        <Notice tone="info">
          To make part of it withdrawable, the administrator sends it to the group wallet and assigns it to your account. It then appears in your available balance
          and as &quot;Moved to platform&quot; below.
        </Notice>
      </div>
      <Card className="mt-6">
        <CardHeader title={`History (${holding.entries.length})`} subtitle="Every entry is permanent; corrections appear as separate entries." />
        <Table head={['Date', 'Type', 'Amount', 'Reason']} empty={holding.entries.length ? null : <EmptyState title="No entries yet" />}>
          {holding.entries.map((e) => (
            <tr key={e.id}>
              <Td className="text-fg-muted">{e.occurredOn}</Td>
              <Td><OffchainKind kind={e.kind} category={e.category} /></Td>
              <Td><Money value={e.amountMicro} decimals={MICRO_DECIMALS} signed colored /></Td>
              <Td className="max-w-md">
                {e.reason}
                {e.reversed ? <span className="block text-xs text-loss">Reversed</span> : null}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
