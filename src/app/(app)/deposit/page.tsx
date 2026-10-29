import type { Metadata } from 'next';
import { pageUser } from '@/server/http/auth';
import { webDb } from '@/server/db';
import { listActiveTokens, listDeposits } from '@/server/queries/user';
import { serverEnv } from '@/server/env';
import { Badge, Card, CardHeader, EmptyState, Mono, PageHeader, SimulatedBadge, Table, Td, shortHash } from '@/components/ui/primitives';
import { Money } from '@/components/ui/money';
import { DepositStatus } from '@/components/ui/status';
import { DepositPanel } from '@/components/app/deposit-panel';
import { AutoRefresh } from '@/components/app/auto-refresh';
import { dateTime } from '@/lib/format';
import { memberHolding, MICRO_DECIMALS } from '@/server/offchain/holdings';
import { listAdjustments } from '@/server/adjustments/manual';

export const metadata: Metadata = { title: 'Deposit' };

export default async function DepositPage() {
  const user = await pageUser();
  const db = webDb();
  const [tokens, deposits, holding, adjustments] = await Promise.all([listActiveTokens(db), listDeposits(db, user.id), memberHolding(db, user.id), listAdjustments(db, user.id)]);
  // Deposits the administrator recorded for money paid to them personally: credited to the
  // platform balance (operator float) or kept in the balance they hold for the member.
  const recorded = [
    ...adjustments
      .filter((a) => a.fund === 'operator_float' && a.direction === 'credit' && !a.reverses_adjustment_id && a.status !== 'cancelled' && a.status !== 'failed')
      .map((a) => ({
        key: `a:${a.id}`,
        at: a.created_at,
        amount: a.amount_base,
        decimals: Number(a.decimals),
        symbol: a.symbol,
        note: a.reason,
        where: 'Available balance',
        status: a.reversed ? 'reversed' : a.status === 'posted' ? 'credited' : 'pending',
      })),
    ...(holding?.entries ?? [])
      // Deposits recorded by hand, and balance edits that raised the balance.
      .filter((e) => e.kind === 'contribution' || (e.kind === 'adjustment' && e.amountMicro > 0n))
      .map((e) => ({
        key: `h:${e.id}`,
        at: e.createdAt,
        amount: e.amountMicro,
        decimals: MICRO_DECIMALS,
        symbol: 'USDT',
        note: e.reason,
        where: 'Account balance',
        status: e.reversed ? 'reversed' : 'recorded',
      })),
  ].sort((x, y) => new Date(y.at).getTime() - new Date(x.at).getTime());
  const networks = tokens.map((t) => ({ id: t.networkId, name: t.networkName, symbol: t.symbol, isSimulated: t.isSimulatedNetwork, isTestToken: t.isTestToken }));
  const open = deposits.some((d) => ['detected', 'confirming', 'confirmed'].includes(d.status));

  return (
    <>
      <PageHeader title="Deposit USDT" description="Minimum deposit: 50 USDT-equivalent of a supported token. Deposits are credited once confirmed on chain and after compliance checks." />
      <DepositPanel networks={networks} demoMode={serverEnv().DEMO_MODE} />
      <Card className="mt-6">
        <CardHeader title="Deposit history" subtitle={open ? 'Refreshing while deposits are confirming…' : undefined} />
        {open ? <AutoRefresh seconds={5} /> : null}
        <Table head={['Detected', 'Network', 'Amount', 'Confirmations', 'Status', 'Transaction']}
          empty={deposits.length || recorded.length ? null : <EmptyState title="No deposits yet">Choose a network above to get your deposit address.</EmptyState>}>
          {deposits.map((d) => (
            <tr key={d.id}>
              <Td className="whitespace-nowrap text-fg-muted">{dateTime(d.detected_at)}</Td>
              <Td>{d.network} {d.is_simulated ? <SimulatedBadge /> : null}</Td>
              <Td><Money value={d.amount} decimals={d.decimals} symbol={d.symbol ?? 'unsupported token'} /></Td>
              <Td className="num">{Math.min(d.confirmations, d.required_confirmations)}/{d.required_confirmations}</Td>
              <Td>
                <DepositStatus status={d.status} />
                {d.status_reason ? <p className="mt-1 text-xs text-fg-subtle">{d.status_reason.replace(/_/g, ' ')}</p> : null}
              </Td>
              <Td>
                {d.explorer_tx_url && !d.tx_hash.startsWith('sim:') ? (
                  <a className="font-mono text-xs text-accent hover:underline" href={d.explorer_tx_url.replace('{hash}', d.tx_hash)} target="_blank" rel="noreferrer">{shortHash(d.tx_hash)}</a>
                ) : (
                  <Mono>{shortHash(d.tx_hash)}</Mono>
                )}
              </Td>
            </tr>
          ))}
        </Table>
        {recorded.length ? (
          <div className="mt-6">
            <h3 className="mb-2 text-sm font-medium">Paid to the administrator</h3>
            <Table head={['Recorded', 'Amount', 'Added to', 'Status', 'Note']}>
              {recorded.map((r) => (
                <tr key={r.key}>
                  <Td className="whitespace-nowrap text-fg-muted">{dateTime(r.at)}</Td>
                  <Td><Money value={r.amount} decimals={r.decimals} symbol={r.symbol} /></Td>
                  <Td>{r.where}</Td>
                  <Td><Badge tone={r.status === 'reversed' ? 'danger' : r.status === 'pending' ? 'warn' : 'success'}>{r.status}</Badge></Td>
                  <Td className="max-w-xs text-xs text-fg-muted">{r.note}</Td>
                </tr>
              ))}
            </Table>
          </div>
        ) : null}
      </Card>
    </>
  );
}
