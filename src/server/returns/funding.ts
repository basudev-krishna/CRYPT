/**
 * Company funding wallets for fixed daily returns.
 *
 * The company's team sends USDT to the group wallet daily to fund members'
 * returns. An administrator registers those sending addresses once; the worker
 * then records each receipt from them as business revenue (allocation
 * 'business_revenue': D suspense_deposits / C return_reserve) and posts it, so
 * the daily settlement can credit members' available balances without a
 * manual step per transfer.
 *
 * The database refuses an address that is, or has acted as, a member's wallet
 * (and members can't register a funding wallet), and lets the worker create
 * no other kind of allocation. Registering a wallet is always alerted.
 */
import { many, maybeOne, one, type Db } from '../db-core';
import { postAllocation } from '../deposits/allocations';
import { raiseRiskEvent, recordAudit, notify, type Actor } from '../ops';
import { ReturnsError } from './service';
import { utcDate } from './math';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** The database's own refusals (P0005) carry a readable reason; surface it as a domain error. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e.code === 'P0005') throw new ReturnsError(`Refused: ${e.message}`, 'funding_wallet_refused');
    if (e.code === '23505') throw new ReturnsError('This wallet is already registered', 'already_registered');
    throw err;
  }
}

export async function addFundingWallet(
  db: Db,
  args: { networkId: number; address: string; label: string; staffUserId: string; actor: Actor },
): Promise<{ id: string }> {
  const address = args.address.trim();
  if (!ADDRESS_RE.test(address)) throw new ReturnsError('That is not a valid wallet address', 'invalid_address');
  if (args.label.trim().length < 3) throw new ReturnsError('Give the wallet a label (who sends from it)', 'label_required');
  const row = await guarded(() =>
    one<{ id: string }>(db, 'insert into public.return_funding_wallets (network_id, address, label, added_by) values ($1, $2, $3, $4) returning id', [
      args.networkId,
      address.toLowerCase(),
      args.label.trim(),
      args.staffUserId,
    ]),
  );
  const details = { networkId: args.networkId, address: address.toLowerCase(), label: args.label.trim() };
  await recordAudit(db, args.actor, 'returns.funding_wallet_added', { type: 'return_funding_wallet', id: row.id }, details);
  // Receipts from this address will fund returns automatically, so registering one is always visible.
  await raiseRiskEvent(db, { kind: 'return_funding_wallet_added', severity: 'high', subjectType: 'return_funding_wallet', subjectId: row.id, details });
  return row;
}

export async function removeFundingWallet(db: Db, args: { walletId: string; note: string; staffUserId: string; actor: Actor }): Promise<void> {
  if (args.note.trim().length < 10) throw new ReturnsError('A note of at least 10 characters is required', 'note_required');
  const res = await db.query(
    "update public.return_funding_wallets set status = 'removed', removed_by = $2, removed_at = now(), remove_note = $3 where id = $1 and status = 'active'",
    [args.walletId, args.staffUserId, args.note.trim()],
  );
  if (res.rowCount !== 1) throw new ReturnsError('Only an active funding wallet can be removed', 'invalid_state');
  await recordAudit(db, args.actor, 'returns.funding_wallet_removed', { type: 'return_funding_wallet', id: args.walletId }, { note: args.note.trim() });
}

export async function listFundingWallets(db: Db) {
  return many<{ id: string; network_id: number; network_name: string; address: string; label: string; status: string; created_at: Date; removed_at: Date | null; received_base: string; symbol: string | null; decimals: number | null }>(
    db,
    `select f.id, f.network_id, n.name as network_name, f.address, f.label, f.status, f.created_at, f.removed_at,
            coalesce((select sum(d.amount_base) from public.allocations al join public.deposits d on d.id = al.deposit_id
                        join public.chain_transactions c on c.id = d.chain_transaction_id
                       where al.kind = 'business_revenue' and al.status = 'posted' and c.network_id = f.network_id and lower(c.from_address) = f.address), 0)::text as received_base,
            (select t.symbol from public.supported_tokens t where t.network_id = f.network_id and not t.is_native and t.status = 'active' order by t.id limit 1) as symbol,
            (select t.decimals from public.supported_tokens t where t.network_id = f.network_id and not t.is_native and t.status = 'active' order by t.id limit 1) as decimals
       from public.return_funding_wallets f join public.supported_networks n on n.id = f.network_id
      order by f.status, f.created_at desc`,
  );
}

/**
 * Worker: record and post every unattributed receipt from an active funding
 * wallet as business revenue. Idempotent: a receipt with a live allocation is
 * skipped, and the database allows one live allocation per deposit.
 */
export async function recordFundingReceipts(db: Db, actor: Actor, limit = 100): Promise<number> {
  const receipts = await many<{ id: string; tx_hash: string; amount_base: string; detected_at: Date; label: string; added_by: string; wallet_id: string }>(
    db,
    `select d.id, c.tx_hash, d.amount_base::text, d.detected_at, f.label, f.added_by, f.id as wallet_id
       from public.deposits d
       join public.chain_transactions c on c.id = d.chain_transaction_id
       join public.return_funding_wallets f on f.network_id = c.network_id and f.address = lower(c.from_address) and f.status = 'active'
      where d.status = 'under_review' and d.user_id is null and d.token_id is not null
        and d.suspense_entry_id is not null and d.credit_entry_id is null
        and not exists (select 1 from public.allocations a where a.deposit_id = d.id and a.status in ('pending', 'posted'))
      order by d.detected_at limit $1
      for update of d skip locked`,
    [limit],
  );
  let posted = 0;
  for (const r of receipts) {
    const day = utcDate(new Date(r.detected_at));
    const allocation = await maybeOne<{ id: string }>(
      db,
      `insert into public.allocations (deposit_id, kind, reason, created_by) values ($1, 'business_revenue', $2, $3)
       on conflict do nothing returning id`,
      [r.id, `Daily return funding from ${r.label}`, r.added_by],
    );
    if (!allocation) continue;
    await db.query(
      `insert into public.business_revenue_records (allocation_id, business_line, period_start, period_end, evidence_reference, created_by)
       values ($1, $2, $3, $3, $4, $5)`,
      [allocation.id, r.label, day, `On-chain transfer ${r.tx_hash}`, r.added_by],
    );
    await recordAudit(db, actor, 'returns.funding_received', { type: 'allocation', id: allocation.id }, { depositId: r.id, walletId: r.wallet_id, amountBase: r.amount_base });
    if ((await postAllocation(db, allocation.id, actor)) === 'posted') {
      posted++;
      await notify(db, { audience: 'operations', kind: 'return_funding_received', payload: { depositId: r.id, amountBase: r.amount_base, label: r.label }, dedupeKey: `return_funding:${r.id}` });
    }
  }
  return posted;
}
