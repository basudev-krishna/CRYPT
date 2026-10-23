/**
 * Recording manually signed payouts (see custody/manual.ts).
 *
 * The administrator records the hash only after their transaction is mined, and
 * it is checked against the chain before it is accepted: a successful transfer
 * of the withdrawn token, from the group wallet, to the destination, for exactly
 * the net amount. That catches a mistyped or wrong hash at entry instead of
 * letting the monitor find the mismatch later and pause every payout.
 */
import { many, maybeOne, type Db } from '../db-core';
import { parseBase } from '@/lib/money';
import { raiseRiskEvent, recordAudit, type Actor } from '../ops';
import { getToken } from '../chains/registry';
import type { ChainAdapter } from '../chains/types';
import { WithdrawalError } from './service';

const MIN_NOTE = 10;

export interface ManualPayoutTask {
  withdrawalId: string;
  userId: string;
  email: string | null;
  networkId: number;
  network: string;
  destination: string;
  netAmount: bigint;
  symbol: string;
  decimals: number;
  custodyRequestId: string;
  requestedAt: Date;
}

/** Withdrawals waiting for the administrator to send them. */
export async function listManualPayoutTasks(db: Db): Promise<ManualPayoutTask[]> {
  const rows = await many<{
    id: string;
    user_id: string;
    email: string | null;
    network_id: number;
    network: string;
    destination_address: string;
    net_amount_base: string;
    symbol: string;
    decimals: number;
    custody_request_id: string;
    created_at: Date;
  }>(
    db,
    `select w.id, w.user_id, p.email, w.network_id, n.name as network, w.destination_address, w.net_amount_base::text,
            t.symbol, t.decimals, x.custody_request_id, w.created_at
       from public.withdrawal_requests w
       join public.withdrawal_transactions x on x.withdrawal_id = w.id and x.status = 'submitted' and x.custody_provider = 'manual'
       join public.supported_networks n on n.id = w.network_id
       join public.supported_tokens t on t.id = w.token_id
       left join public.user_profiles p on p.user_id = w.user_id
      where w.status = 'processing'
        and not exists (select 1 from public.manual_payouts m where m.custody_request_id = x.custody_request_id)
      order by w.created_at`,
  );
  return rows.map((r) => ({
    withdrawalId: r.id,
    userId: r.user_id,
    email: r.email,
    networkId: Number(r.network_id),
    network: r.network,
    destination: r.destination_address,
    netAmount: parseBase(r.net_amount_base),
    symbol: r.symbol,
    decimals: Number(r.decimals),
    custodyRequestId: r.custody_request_id,
    requestedAt: r.created_at,
  }));
}

async function lockTask(db: Db, withdrawalId: string) {
  const w = await maybeOne<{ id: string; user_id: string; network_id: number; token_id: number; destination_address: string; net_amount_base: string; status: string }>(
    db,
    'select id, user_id, network_id, token_id, destination_address, net_amount_base::text, status from public.withdrawal_requests where id = $1 for update',
    [withdrawalId],
  );
  if (!w) throw new WithdrawalError('Withdrawal not found', 'not_found');
  const attempt = await maybeOne<{ custody_request_id: string }>(
    db,
    "select custody_request_id from public.withdrawal_transactions where withdrawal_id = $1 and status = 'submitted' and custody_provider = 'manual'",
    [w.id],
  );
  if (w.status !== 'processing' || !attempt) throw new WithdrawalError('This withdrawal is not waiting for a manual payout', 'invalid_state');
  const done = await maybeOne<{ x: number }>(db, 'select 1 as x from public.manual_payouts where custody_request_id = $1', [attempt.custody_request_id]);
  if (done) throw new WithdrawalError('This payout has already been recorded', 'already_recorded');
  return { w, key: attempt.custody_request_id };
}

export async function recordManualPayout(
  db: Db,
  adapter: ChainAdapter,
  args: { withdrawalId: string; txHash: string; note: string; staffUserId: string; actor: Actor },
): Promise<void> {
  const note = args.note.trim();
  if (note.length < MIN_NOTE) throw new WithdrawalError(`A note of at least ${MIN_NOTE} characters is required`, 'note_required');
  const txHash = args.txHash.trim().toLowerCase();
  if (!/^(sim:)?0x[0-9a-f]{64}$/.test(txHash)) throw new WithdrawalError('That is not a transaction hash (0x followed by 64 hex characters)', 'invalid_tx_hash');

  const { w, key } = await lockTask(db, args.withdrawalId);
  if (adapter.network.id !== Number(w.network_id)) throw new WithdrawalError('Wrong network for this withdrawal', 'invalid_state');
  const reused = await maybeOne<{ x: number }>(
    db,
    'select 1 as x from public.manual_payouts where tx_hash = $1 union all select 1 from public.withdrawal_transactions where tx_hash = $1 limit 1',
    [txHash],
  );
  if (reused) throw new WithdrawalError('This transaction is already recorded for another payout', 'tx_hash_reused');

  const token = await getToken(db, Number(w.token_id));
  const hot = await maybeOne<{ address: string }>(
    db,
    "select address from public.treasury_wallets where network_id = $1 and kind = 'hot' and is_active order by id limit 1",
    [w.network_id],
  );
  if (!hot) throw new WithdrawalError('No group wallet is configured for this network', 'invalid_state');

  const lookup = await adapter.lookupTransaction(txHash);
  if (lookup.status === 'not_found') throw new WithdrawalError('That transaction was not found on this network. Check the hash and the network.', 'tx_not_found');
  if (lookup.status === 'pending') throw new WithdrawalError('That transaction is not mined yet. Record it once it shows as successful.', 'tx_pending');
  if (lookup.status === 'failed') throw new WithdrawalError('That transaction failed on chain, so nothing was sent. Send the payout again.', 'tx_failed');
  const pays = lookup.transfers.some(
    (t) =>
      t.tokenContract === token.contractAddress?.toLowerCase() &&
      t.from === hot.address.toLowerCase() &&
      t.to === w.destination_address.toLowerCase() &&
      t.amount === parseBase(w.net_amount_base),
  );
  if (!pays) {
    throw new WithdrawalError(
      `That transaction does not send exactly the net amount of ${token.symbol} from the group wallet to ${w.destination_address}.`,
      'tx_mismatch',
    );
  }

  await db.query('insert into public.manual_payouts (custody_request_id, tx_hash, note, recorded_by) values ($1, $2, $3, $4)', [key, txHash, note, args.staffUserId]);
  const toSelf = w.user_id === args.staffUserId;
  const details = { withdrawalId: w.id, txHash, netAmountBase: w.net_amount_base, toSelf };
  await recordAudit(db, args.actor, 'withdrawal.manual_payout_recorded', { type: 'withdrawal', id: w.id }, details);
  await raiseRiskEvent(db, { userId: w.user_id, kind: toSelf ? 'admin_self_payout' : 'admin_manual_payout', severity: 'high', subjectType: 'withdrawal', subjectId: w.id, details });
}

/** Decline to send: the worker then fails the attempt and releases the member's reservation. */
export async function cancelManualPayout(db: Db, args: { withdrawalId: string; note: string; staffUserId: string; actor: Actor }): Promise<void> {
  const note = args.note.trim();
  if (note.length < MIN_NOTE) throw new WithdrawalError(`A note of at least ${MIN_NOTE} characters is required`, 'note_required');
  const { w, key } = await lockTask(db, args.withdrawalId);
  await db.query('insert into public.manual_payouts (custody_request_id, cancelled, note, recorded_by) values ($1, true, $2, $3)', [key, note, args.staffUserId]);
  await recordAudit(db, args.actor, 'withdrawal.manual_payout_cancelled', { type: 'withdrawal', id: w.id }, { note });
}
