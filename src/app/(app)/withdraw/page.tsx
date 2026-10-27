import type { Metadata } from 'next';
import { pageUser } from '@/server/http/auth';
import { webDb } from '@/server/db';
import { listActiveTokens, listWithdrawals, getDashboard } from '@/server/queries/user';
import { currentPolicy, isControlEnabled } from '@/server/ops';
import { Card, CardHeader, EmptyState, Mono, PageHeader, SimulatedBadge, Table, Td, shortHash } from '@/components/ui/primitives';
import { Money } from '@/components/ui/money';
import { WithdrawalStatus } from '@/components/ui/status';
import { WithdrawForm } from '@/components/app/withdraw-form';
import { ActionButton } from '@/components/app/actions';
import { AutoRefresh } from '@/components/app/auto-refresh';
import { dateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Withdraw' };

export default async function WithdrawPage() {
  const user = await pageUser();
  const db = webDb();
  const [tokens, items, dash, policy, paused] = await Promise.all([
    listActiveTokens(db),
    listWithdrawals(db, user.id),
    getDashboard(db, user.id),
    currentPolicy(db, 'withdrawal'),
    isControlEnabled(db, 'withdrawals_paused'),
  ]);
  const networks = tokens.map((t) => ({ id: t.networkId, name: t.networkName, symbol: t.symbol, decimals: t.decimals }));
  const token = tokens[0];
  const minRow = token ? await db.query<{ m: string }>('select min_withdrawal_base::text as m from public.supported_tokens where id = $1', [token.id]) : null;
  const blocked = paused
    ? 'Withdrawals are temporarily paused by operations. Your funds remain in your account.'
    : policy.params.require_kyc_approved && dash.profile?.kycStatus !== 'approved'
      ? 'Identity verification must be approved before withdrawing.'
      : dash.profile?.accountStatus !== 'active'
        ? 'Your account is restricted. Contact support.'
        : null;
  const open = items.some((w) => ['reserved', 'processing', 'broadcast'].includes(w.status));

  return (
    <>
      <PageHeader title="Withdraw USDT" description="Withdrawals are processed automatically only when every configured security, compliance and liquidity check passes." />
      <div className="grid gap-6 xl:grid-cols-[3fr_2fr]">
        <WithdrawForm
          networks={networks}
          availableBase={dash.available.toString()}
          feeBase={policy.params.fee_base.toString()}
          minBase={minRow?.rows[0]?.m ?? '0'}
          mfaEnrolled={user.hasMfaFactor}
          blockedReason={blocked}
        />
        <Card>
          <CardHeader title="How withdrawals work" />
          <ol className="list-decimal space-y-2 pl-5 text-sm text-fg-muted">
            <li>Your request is validated (network, address, limits, balance).</li>
            <li>You confirm with your authenticator; the amount is reserved atomically.</li>
            <li>Automated checks run: address screening, new-address cooldown, limits, treasury liquidity and reconciliation status. Some requests go to manual compliance review.</li>
            <li>The custody provider signs and broadcasts the transfer (one attempt per idempotency key).</li>
            <li>After the network&apos;s required confirmations the withdrawal is settled. Failed transfers release your reserved funds.</li>
          </ol>
          <p className="mt-4 text-xs text-fg-subtle">Fee policy v{policy.version}: <Money value={policy.params.fee_base} decimals={token?.decimals ?? 6} symbol={token?.symbol} /> per withdrawal. Network gas is paid by the platform.</p>
        </Card>
      </div>
      <Card className="mt-6">
        <CardHeader title="Withdrawal history" />
        {open ? <AutoRefresh seconds={5} /> : null}
        <Table head={['Requested', 'Destination', 'Amount', 'You receive', 'Status', 'Transaction', '']}
          empty={items.length ? null : <EmptyState title="No withdrawals yet" />}>
          {items.map((w) => (
            <tr key={w.id}>
              <Td className="whitespace-nowrap text-fg-muted">{dateTime(w.created_at)}</Td>
              <Td><Mono>{shortHash(w.destination_address, 6)}</Mono></Td>
              <Td><Money value={w.amount} decimals={w.decimals} symbol={w.symbol} /></Td>
              <Td><Money value={w.net} decimals={w.decimals} /></Td>
              <Td>
                <WithdrawalStatus status={w.status} /> {w.is_simulated ? <SimulatedBadge /> : null}
                {w.requires_manual_review && w.status === 'reserved' ? <p className="mt-1 text-xs text-warn">In compliance review</p> : null}
                {w.status_reason ? <p className="mt-1 text-xs text-fg-subtle">{w.status_reason}</p> : null}
              </Td>
              <Td>
                <Mono>{shortHash(w.tx_hash)}</Mono>
                {w.tx_hash && w.status === 'broadcast' ? <p className="text-xs text-fg-subtle">{w.confirmations ?? 0} confirmations</p> : null}
              </Td>
              <Td>{['pending_verification', 'reserved'].includes(w.status) ? <ActionButton url={`/api/withdrawals/${w.id}/cancel`} confirmText="Cancel this withdrawal?" variant="ghost">Cancel</ActionButton> : null}</Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
