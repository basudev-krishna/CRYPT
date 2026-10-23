/**
 * Deposit lifecycle
 *
 *   detected -> confirming -> confirmed -> credited
 *                                     \-> under_review (KYC, minimum, screening, size) -> credited | recovery_required
 *   any pre-credit state -> failed (reverted / dropped / reorged)
 *   mismatch on re-verification or unsupported token -> recovery_required
 *
 * Accounting (two idempotent entries per deposit):
 *   receive  (at required confirmations): D treasury_hot      C suspense_deposits
 *   credit   (after all checks pass):     D suspense_deposits C user_cash
 * So the ledger always reflects confirmed on-chain receipts, even while a
 * deposit is under review, and a deposit can be credited at most once
 * (unique idempotency keys + deposits.credit_entry_id unique).
 */
import { many, maybeOne, one, type Db } from '../db-core';
import { parseBase } from '@/lib/money';
import { ensureAccount, postEntry, transfer } from '../ledger/ledger';
import { getAccountStatus, getKycStatus, getScreeningProvider, type AddressScreeningProvider } from '../compliance/compliance';
import { currentPolicy, isControlEnabled, isSoleAdmin, notify, raiseRiskEvent, recordAudit, serviceActor, type Actor } from '../ops';
import { findTokenByContract, getDepositToken, getNetwork } from '../chains/registry';
import type { ChainAdapter, ObservedTransfer } from '../chains/types';
import type { CustodyProvider } from '../custody/types';
import { requestSubscription, getPoolForToken } from '../investment/orders';

export class DepositError extends Error {
  override name = 'DepositError';
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

// -----------------------------------------------------------------------------
// Deposit instructions / address issuance
// -----------------------------------------------------------------------------
export interface DepositInstructions {
  network: { id: number; code: string; name: string; isTestnet: boolean; isSimulated: boolean; requiredConfirmations: number };
  token: { id: number; symbol: string; contractAddress: string; decimals: number; isTestToken: boolean };
  address: string;
  /**
   * `group_wallet`: `address` is shared by every member and deposits are
   * attributed by the sender, so the member must send from a registered wallet.
   * `deposit_address`: `address` is this member's own.
   */
  mode: 'group_wallet' | 'deposit_address';
  minDepositBase: bigint;
}

/** The active shared wallet that accepts member deposits on a network, if any. */
export async function getGroupWallet(db: Db, networkId: number): Promise<{ id: number; address: string } | null> {
  const row = await maybeOne<{ id: number; address: string }>(
    db,
    'select id, address from public.treasury_wallets where network_id = $1 and receives_deposits and is_active order by id limit 1',
    [networkId],
  );
  return row ? { id: Number(row.id), address: row.address } : null;
}

export async function getDepositInstructions(db: Db, custody: CustodyProvider, userId: string, networkId: number, actor: Actor): Promise<DepositInstructions> {
  const network = await getNetwork(db, networkId);
  if (network.status !== 'active') throw new DepositError('This network is not accepting deposits', 'network_unavailable');
  if (await isControlEnabled(db, 'deposits_paused')) throw new DepositError('Deposits are temporarily paused', 'deposits_paused');

  const token = await getDepositToken(db, networkId);
  if (!token || !token.contractAddress) throw new DepositError('No supported token on this network', 'token_unavailable');

  const accountStatus = await getAccountStatus(db, userId);
  if (accountStatus !== 'active') throw new DepositError('Your account is not permitted to deposit', 'account_restricted');

  const policy = await currentPolicy(db, 'deposit');
  if (policy.params.require_kyc_approved && (await getKycStatus(db, userId)) !== 'approved') {
    throw new DepositError('Identity verification must be approved before depositing', 'kyc_required');
  }

  const networkInfo = {
    id: network.id,
    code: network.code,
    name: network.name,
    isTestnet: network.isTestnet,
    isSimulated: network.family === 'simulated',
    requiredConfirmations: network.requiredConfirmations,
  };
  const tokenInfo = { id: token.id, symbol: token.symbol, contractAddress: token.contractAddress, decimals: token.decimals, isTestToken: token.isTestToken };

  // A group wallet needs no custody: the address is shared and watched, never signed for.
  const group = await getGroupWallet(db, networkId);
  if (group) return { network: networkInfo, token: tokenInfo, address: group.address, mode: 'group_wallet', minDepositBase: token.minDepositBase };

  if (!custody.supportsNetwork(network.code)) throw new DepositError('Custody is not configured for this network', 'custody_unavailable');

  let row = await maybeOne<{ address: string }>(
    db,
    "select address from public.deposit_addresses where user_id = $1 and network_id = $2 and status = 'active'",
    [userId, networkId],
  );
  if (!row) {
    const issued = await custody.createDepositAddress({ networkId, networkCode: network.code, userId });
    await db.query(
      `insert into public.deposit_addresses (user_id, network_id, address, custody_provider, custody_ref)
       values ($1, $2, $3, $4, $5) on conflict do nothing`,
      [userId, networkId, issued.address.toLowerCase(), custody.name, issued.custodyRef],
    );
    row = await one<{ address: string }>(
      db,
      "select address from public.deposit_addresses where user_id = $1 and network_id = $2 and status = 'active'",
      [userId, networkId],
    );
    await recordAudit(db, actor, 'deposit.address_issued', { type: 'deposit_address', id: row.address }, { networkId });
  }

  return { network: networkInfo, token: tokenInfo, address: row.address, mode: 'deposit_address', minDepositBase: token.minDepositBase };
}

// -----------------------------------------------------------------------------
// Ingestion
// -----------------------------------------------------------------------------
/**
 * Record an observed inbound transfer and create its deposit row. Safe to call
 * any number of times for the same (network, tx, log index).
 */
export async function recordInboundTransfer(
  db: Db,
  networkId: number,
  t: ObservedTransfer,
  opts: { isSimulated: boolean; requiredConfirmations: number },
): Promise<{ depositId: string | null; isNew: boolean }> {
  const token = await findTokenByContract(db, networkId, t.tokenContract);
  const inserted = await maybeOne<{ id: string }>(
    db,
    `insert into public.chain_transactions
       (network_id, tx_hash, log_index, block_number, block_hash, from_address, to_address, token_contract, token_id, amount_base, direction, status, is_simulated)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'inbound', 'detected', $11)
     on conflict (network_id, tx_hash, log_index) do nothing
     returning id`,
    [networkId, t.txHash, t.logIndex, t.blockNumber.toString(), t.blockHash, t.from, t.to, t.tokenContract, token?.id ?? null, t.amount.toString(), opts.isSimulated],
  );
  const chainTx =
    inserted ??
    (await one<{ id: string }>(db, 'select id from public.chain_transactions where network_id = $1 and tx_hash = $2 and log_index = $3', [
      networkId,
      t.txHash,
      t.logIndex,
    ]));

  const dest = await resolveDestination(db, networkId, t);
  if (!dest) return { depositId: null, isNew: false }; // not one of ours, or an internal movement

  const unsupported = !token || token.isNative || token.status === 'disabled';
  const dep = await maybeOne<{ id: string }>(
    db,
    `insert into public.deposits
       (user_id, network_id, token_id, deposit_address_id, treasury_wallet_id, member_wallet_id, chain_transaction_id, amount_base, status, status_reason, required_confirmations)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     on conflict (chain_transaction_id) do nothing
     returning id`,
    [
      dest.userId,
      networkId,
      token?.id ?? null,
      dest.depositAddressId,
      dest.treasuryWalletId,
      dest.memberWalletId,
      chainTx.id,
      t.amount.toString(),
      unsupported ? 'recovery_required' : 'detected',
      unsupported ? 'unsupported_token' : null,
      opts.requiredConfirmations,
    ],
  );
  if (dep) {
    if (unsupported) {
      await raiseRiskEvent(db, {
        userId: dest.userId,
        kind: 'unsupported_token_deposit',
        severity: 'medium',
        subjectType: 'deposit',
        subjectId: dep.id,
        details: { tokenContract: t.tokenContract, txHash: t.txHash },
      });
    }
    if (dest.userId) {
      await notify(db, { userId: dest.userId, kind: 'deposit_detected', payload: { depositId: dep.id, txHash: t.txHash }, dedupeKey: `deposit_detected:${dep.id}` });
    }
    return { depositId: dep.id, isNew: true };
  }
  const existing = await one<{ id: string; status: string; chain_status: string }>(
    db,
    'select d.id, d.status::text, c.status::text as chain_status from public.deposits d join public.chain_transactions c on c.id = d.chain_transaction_id where d.chain_transaction_id = $1',
    [chainTx.id],
  );
  // The same transfer was marked reorged out but is on chain again. Never revive
  // it automatically (it was already resolved as failed); surface it for recovery.
  if (existing.status === 'failed' && existing.chain_status === 'reorged') {
    await db.query(
      "update public.deposits set status = 'recovery_required', status_reason = 'transfer reappeared on chain after being reorged out' where id = $1",
      [existing.id],
    );
    await raiseRiskEvent(db, {
      userId: dest.userId,
      kind: 'deposit_reappeared_after_reorg',
      severity: 'high',
      subjectType: 'deposit',
      subjectId: existing.id,
      details: { txHash: t.txHash, logIndex: t.logIndex, blockNumber: t.blockNumber.toString() },
    });
  }
  return { depositId: existing.id, isNew: false };
}

interface Destination {
  userId: string | null;
  depositAddressId: string | null;
  treasuryWalletId: number | null;
  memberWalletId: string | null;
}

/** The member's active registered wallet that sent a transfer, if any. */
async function senderWallet(db: Db, networkId: number, from: string): Promise<{ id: string; user_id: string } | null> {
  return maybeOne<{ id: string; user_id: string }>(
    db,
    "select id, user_id from public.member_wallets where network_id = $1 and address = $2 and status = 'active'",
    [networkId, from.toLowerCase()],
  );
}

/**
 * Who a transfer is for. A per-user deposit address names its owner. A transfer
 * to the group wallet belongs to whoever registered the sending wallet, or to
 * nobody yet (user null) if the sender is unknown.
 */
async function resolveDestination(db: Db, networkId: number, t: ObservedTransfer): Promise<Destination | null> {
  const address = await maybeOne<{ id: string; user_id: string }>(
    db,
    'select id, user_id from public.deposit_addresses where network_id = $1 and address = $2',
    [networkId, t.to],
  );
  if (address) return { userId: address.user_id, depositAddressId: address.id, treasuryWalletId: null, memberWalletId: null };

  const group = await maybeOne<{ id: number }>(
    db,
    'select id from public.treasury_wallets where network_id = $1 and address = $2 and receives_deposits',
    [networkId, t.to],
  );
  if (!group) return null; // e.g. a sweep into the hot wallet

  // Movements between platform wallets (sweeps, rebalancing) are not deposits.
  const internal = await maybeOne<{ x: number }>(
    db,
    `select 1 as x from public.treasury_wallets where network_id = $1 and address = $2
     union all select 1 from public.deposit_addresses where network_id = $1 and address = $2 limit 1`,
    [networkId, t.from],
  );
  if (internal) return null;

  const sender = await senderWallet(db, networkId, t.from);
  return { userId: sender?.user_id ?? null, depositAddressId: null, treasuryWalletId: Number(group.id), memberWalletId: sender?.id ?? null };
}

/** Scan new blocks for transfers to our deposit addresses and group wallets. Returns the number of transfers seen. */
export async function ingestNetwork(db: Db, adapter: ChainAdapter, opts: { initialLookback?: bigint; maxBlocks?: bigint } = {}): Promise<number> {
  const network = adapter.network;
  const token = await getDepositToken(db, network.id);
  if (!token?.contractAddress) return 0;
  await adapter.assertTokenDecimals(token.contractAddress, token.decimals);

  const head = await adapter.getBlockNumber();
  const state = await maybeOne<{ last_scanned_block: string }>(db, 'select last_scanned_block::text from public.network_scan_state where network_id = $1', [network.id]);
  const lookback = opts.initialLookback ?? 5_000n;
  const last = state ? BigInt(state.last_scanned_block) : head > lookback ? head - lookback : 0n;
  // Re-scan the unfinalized window on every pass; dedupe makes this safe and it
  // catches logs that appeared after a reorg.
  const reorgWindow = BigInt(network.requiredConfirmations);
  const from = last > reorgWindow ? last - reorgWindow : 0n;
  const maxBlocks = opts.maxBlocks ?? 10_000n;
  const to = head - from > maxBlocks ? from + maxBlocks : head;

  const recipients = (
    await many<{ address: string }>(
      db,
      `select address from public.deposit_addresses where network_id = $1
       union select address from public.treasury_wallets where network_id = $1 and receives_deposits and is_active`,
      [network.id],
    )
  ).map((r) => r.address);
  let seen = 0;
  for (let i = 0; i < recipients.length; i += 500) {
    const transfers = await adapter.scanTransfers({ tokenContract: token.contractAddress, recipients: recipients.slice(i, i + 500), fromBlock: from, toBlock: to });
    for (const t of transfers) {
      await recordInboundTransfer(db, network.id, t, { isSimulated: adapter.isSimulated, requiredConfirmations: network.requiredConfirmations });
      seen++;
    }
  }
  await db.query(
    `insert into public.network_scan_state (network_id, last_scanned_block) values ($1, $2)
     on conflict (network_id) do update set last_scanned_block = greatest(public.network_scan_state.last_scanned_block, excluded.last_scanned_block), updated_at = now()`,
    [network.id, to.toString()],
  );
  return seen;
}

// -----------------------------------------------------------------------------
// Confirmation tracking
// -----------------------------------------------------------------------------
interface DepositRow {
  id: string;
  user_id: string | null;
  network_id: number;
  token_id: number | null;
  amount_base: string;
  status: string;
  required_confirmations: number;
  chain_transaction_id: string;
  tx_hash: string;
  log_index: number;
  to_address: string;
  token_contract: string | null;
  block_hash: string | null;
  from_address: string;
  credit_entry_id: string | null;
  suspense_entry_id: string | null;
  treasury_wallet_id: number | null;
}

const DEPOSIT_SELECT = `
  select d.id, d.user_id, d.network_id, d.token_id, d.amount_base::text, d.status, d.required_confirmations,
         d.chain_transaction_id, c.tx_hash, c.log_index, c.to_address, c.token_contract, c.block_hash, c.from_address,
         d.credit_entry_id, d.suspense_entry_id, d.treasury_wallet_id
    from public.deposits d join public.chain_transactions c on c.id = d.chain_transaction_id`;

async function loadDeposit(db: Db, id: string, lock = false): Promise<DepositRow> {
  return one<DepositRow>(db, `${DEPOSIT_SELECT} where d.id = $1 ${lock ? 'for update of d' : ''}`, [id]);
}

export type RefreshOutcome = 'confirming' | 'confirmed' | 'failed' | 'recovery_required' | 'unchanged';

/**
 * Re-verify a pending deposit against the chain and advance it. Verification
 * checks receipt status, that the exact log still exists with the same token
 * contract, recipient and amount, and the confirmation depth.
 */
export async function refreshDeposit(db: Db, adapter: ChainAdapter, depositId: string): Promise<RefreshOutcome> {
  const d = await loadDeposit(db, depositId, true);
  if (!['detected', 'confirming'].includes(d.status)) return 'unchanged';

  const lookup = await adapter.lookupTransaction(d.tx_hash);
  const setChain = (status: string, confirmations: number, success: boolean | null) =>
    db.query('update public.chain_transactions set status = $2::public.chain_tx_status, confirmations = $3, receipt_success = $4 where id = $1', [
      d.chain_transaction_id,
      status,
      confirmations,
      success,
    ]);

  if (lookup.status === 'pending') return 'unchanged';
  if (lookup.status === 'not_found') {
    await setChain('reorged', 0, null);
    await db.query("update public.deposits set status = 'failed', status_reason = 'transaction dropped or reorged out' where id = $1", [d.id]);
    return 'failed';
  }
  if (lookup.status === 'failed') {
    await setChain('failed', lookup.confirmations, false);
    await db.query("update public.deposits set status = 'failed', status_reason = 'transaction reverted' where id = $1", [d.id]);
    return 'failed';
  }

  const match = lookup.transfers.find(
    (t) =>
      t.logIndex === d.log_index &&
      t.to === d.to_address &&
      t.tokenContract === (d.token_contract ?? '') &&
      t.amount === parseBase(d.amount_base),
  );
  if (!match) {
    await setChain('reorged', lookup.confirmations, true);
    await db.query("update public.deposits set status = 'recovery_required', status_reason = 'on-chain transfer no longer matches observed event' where id = $1", [d.id]);
    await raiseRiskEvent(db, {
      userId: d.user_id,
      kind: 'deposit_verification_mismatch',
      severity: 'high',
      subjectType: 'deposit',
      subjectId: d.id,
      details: { txHash: d.tx_hash },
    });
    return 'recovery_required';
  }

  const confirmed = lookup.confirmations >= d.required_confirmations;
  await db.query('update public.chain_transactions set block_hash = $2, block_number = $3 where id = $1', [
    d.chain_transaction_id,
    lookup.blockHash,
    lookup.blockNumber.toString(),
  ]);
  await setChain(confirmed ? 'confirmed' : 'confirming', lookup.confirmations, true);
  await db.query(
    `update public.deposits set status = $2::public.deposit_status, confirmations = $3,
            confirmed_at = case when $2::text = 'confirmed' then now() else confirmed_at end where id = $1`,
    [d.id, confirmed ? 'confirmed' : 'confirming', lookup.confirmations],
  );
  return confirmed ? 'confirmed' : 'confirming';
}

// -----------------------------------------------------------------------------
// Crediting
// -----------------------------------------------------------------------------
export type CreditOutcome = 'credited' | 'under_review' | 'deferred' | 'unchanged';

/** Post the receive entry (treasury vs suspense) for a confirmed deposit. Idempotent. */
async function postReceive(db: Db, d: DepositRow, tokenId: number): Promise<string> {
  if (d.suspense_entry_id) return d.suspense_entry_id;
  const treasury = await ensureAccount(db, 'treasury_hot', tokenId);
  const suspense = await ensureAccount(db, 'suspense_deposits', tokenId);
  const entryId = await postEntry(db, {
    idempotencyKey: `deposit:receive:${d.id}`,
    eventType: 'deposit_received',
    sourceType: 'deposit',
    sourceId: d.id,
    description: `Confirmed on-chain receipt ${d.tx_hash}#${d.log_index}`,
    postedBy: 'service:deposit-crediter',
    lines: transfer(treasury, suspense, parseBase(d.amount_base)),
    metadata: { txHash: d.tx_hash, logIndex: d.log_index },
  });
  await db.query('update public.deposits set suspense_entry_id = $2 where id = $1', [d.id, entryId]);
  return entryId;
}

/** Move funds from suspense to the customer's cash balance. Idempotent. */
async function postCredit(db: Db, d: DepositRow, tokenId: number, userId: string, postedBy: string): Promise<string> {
  const suspense = await ensureAccount(db, 'suspense_deposits', tokenId);
  const cash = await ensureAccount(db, 'user_cash', tokenId, { userId });
  return postEntry(db, {
    idempotencyKey: `deposit:credit:${d.id}`,
    eventType: 'deposit_credit',
    sourceType: 'deposit',
    sourceId: d.id,
    description: `Deposit credited (${d.tx_hash})`,
    postedBy,
    lines: transfer(suspense, cash, parseBase(d.amount_base)),
    metadata: { txHash: d.tx_hash },
  });
}

async function finishCredit(db: Db, d: DepositRow, tokenId: number, userId: string, entryId: string, autoSubscribe: boolean, actor: Actor): Promise<void> {
  await db.query("update public.deposits set status = 'credited', status_reason = null, credit_entry_id = $2, credited_at = now() where id = $1", [d.id, entryId]);
  await recordAudit(db, actor, 'deposit.credited', { type: 'deposit', id: d.id }, { amountBase: d.amount_base, entryId });
  await notify(db, { userId, kind: 'deposit_credited', payload: { depositId: d.id, amountBase: d.amount_base }, dedupeKey: `deposit_credited:${d.id}` });

  if (autoSubscribe) {
    const pool = await getPoolForToken(db, tokenId);
    if (pool) {
      await requestSubscription(db, { userId, poolId: pool.id, tokenId, amount: parseBase(d.amount_base), idempotencyKey: `deposit-subscribe:${d.id}`, actor });
    }
  }
}

/** Run compliance/risk checks on a confirmed deposit and credit it if they all pass. */
export async function creditDeposit(
  db: Db,
  depositId: string,
  deps: { screening?: AddressScreeningProvider } = {},
): Promise<CreditOutcome> {
  const actor = serviceActor('deposit-crediter');
  const d = await loadDeposit(db, depositId, true);
  if (d.status !== 'confirmed') return 'unchanged';
  if (d.token_id === null) return 'unchanged';
  const tokenId = Number(d.token_id);

  // Confirmed funds are in the wallet whoever they belong to, so the receipt is
  // always booked; only the credit to a member depends on attribution.
  await postReceive(db, d, tokenId);
  if (await isControlEnabled(db, 'deposits_paused')) return 'deferred';

  let userId = d.user_id;
  if (userId === null && d.treasury_wallet_id !== null) {
    // The sender may have registered their wallet after sending.
    const sender = await senderWallet(db, Number(d.network_id), d.from_address);
    if (sender) {
      await db.query('update public.deposits set user_id = $2, member_wallet_id = $3 where id = $1 and user_id is null', [d.id, sender.user_id, sender.id]);
      userId = sender.user_id;
    }
  }
  if (userId === null) {
    // Nobody to credit: hold in suspense until an admin allocates it.
    await db.query("update public.deposits set status = 'under_review', status_reason = 'unattributed' where id = $1", [d.id]);
    await raiseRiskEvent(db, {
      kind: 'deposit_unattributed',
      severity: 'low',
      subjectType: 'deposit',
      subjectId: d.id,
      details: { txHash: d.tx_hash, from: d.from_address, amountBase: d.amount_base },
    });
    await notify(db, { audience: 'operations', kind: 'deposit_unattributed', payload: { depositId: d.id } });
    return 'under_review';
  }

  const policy = await currentPolicy(db, 'deposit');
  const token = await one<{ min_deposit_base: string; code: string }>(
    db,
    'select t.min_deposit_base::text, n.code from public.supported_tokens t join public.supported_networks n on n.id = t.network_id where t.id = $1',
    [tokenId],
  );
  const amount = parseBase(d.amount_base);
  const screening = await (deps.screening ?? getScreeningProvider()).screen(token.code, d.from_address);

  const reasons: string[] = [];
  if (amount < parseBase(token.min_deposit_base)) reasons.push('below_minimum');
  if ((await getAccountStatus(db, userId)) !== 'active') reasons.push('account_not_active');
  if (policy.params.require_kyc_approved && (await getKycStatus(db, userId)) !== 'approved') reasons.push('kyc_not_approved');
  if (amount > policy.params.manual_review_above_base) reasons.push('large_deposit_review');
  if (screening.risk === 'high' || screening.risk === 'severe') reasons.push('source_address_risk');

  const riskResult = { policyVersion: policy.version, screening, reasons };
  if (reasons.length > 0) {
    await db.query("update public.deposits set status = 'under_review', status_reason = $2, risk_result = $3::jsonb, policy_version_id = $4 where id = $1", [
      d.id,
      reasons.join(','),
      JSON.stringify(riskResult),
      policy.id,
    ]);
    await raiseRiskEvent(db, {
      userId,
      kind: 'deposit_under_review',
      severity: reasons.includes('source_address_risk') ? 'high' : 'low',
      subjectType: 'deposit',
      subjectId: d.id,
      details: riskResult,
    });
    await notify(db, { userId, kind: 'deposit_under_review', payload: { depositId: d.id }, dedupeKey: `deposit_review:${d.id}` });
    return 'under_review';
  }

  await db.query('update public.deposits set risk_result = $2::jsonb, policy_version_id = $3 where id = $1', [d.id, JSON.stringify(riskResult), policy.id]);
  const entryId = await postCredit(db, d, tokenId, userId, `${actor.type}:${actor.id}`);
  await finishCredit(db, d, tokenId, userId, entryId, policy.params.auto_subscribe, actor);
  return 'credited';
}

/** Compliance decision on a deposit under review. Approve credits it; reject leaves funds in suspense for recovery. */
export async function reviewDeposit(db: Db, depositId: string, decision: 'approve' | 'reject', note: string, actor: Actor): Promise<void> {
  if (note.trim().length < 10) throw new DepositError('A review note of at least 10 characters is required', 'note_required');
  const d = await loadDeposit(db, depositId, true);
  if (d.status !== 'under_review') throw new DepositError('Deposit is not under review', 'invalid_state');
  if (d.token_id === null || d.user_id === null) throw new DepositError('Deposit cannot be attributed', 'invalid_state');
  if (actor.type === 'staff' && actor.id === d.user_id) {
    if (!(await isSoleAdmin(db, actor.id))) throw new DepositError('Staff cannot review their own deposit', 'conflict_of_interest');
    await raiseRiskEvent(db, { userId: d.user_id, kind: 'admin_self_review', severity: 'high', subjectType: 'deposit', subjectId: d.id, details: { decision, note } });
  }

  if (decision === 'reject') {
    await db.query("update public.deposits set status = 'recovery_required', status_reason = $2 where id = $1", [d.id, `rejected: ${note}`]);
    await recordAudit(db, actor, 'deposit.review_rejected', { type: 'deposit', id: d.id }, { note });
    return;
  }
  if ((await getAccountStatus(db, d.user_id)) !== 'active') throw new DepositError('Account is not active', 'account_restricted');
  const tokenId = Number(d.token_id);
  // The minimum is a hard rule, not a review reason a reviewer can waive:
  // below-minimum funds stay in suspense and are returned via recovery.
  const min = await one<{ min_deposit_base: string }>(db, 'select min_deposit_base::text from public.supported_tokens where id = $1', [tokenId]);
  if (parseBase(d.amount_base) < parseBase(min.min_deposit_base)) {
    throw new DepositError('Deposits below the minimum cannot be credited; reject it for recovery instead', 'below_minimum');
  }
  await postReceive(db, d, tokenId);
  const entryId = await postCredit(db, d, tokenId, d.user_id, `${actor.type}:${actor.id}`);
  await recordAudit(db, actor, 'deposit.review_approved', { type: 'deposit', id: d.id }, { note });
  const policy = await currentPolicy(db, 'deposit');
  await finishCredit(db, d, tokenId, d.user_id, entryId, policy.params.auto_subscribe, actor);
}

// -----------------------------------------------------------------------------
// Manual investigation of a reported (missing) deposit
// -----------------------------------------------------------------------------
export type InvestigationResult =
  | { outcome: 'recorded'; depositIds: string[] }
  | { outcome: 'not_found' | 'pending' | 'reverted' | 'no_transfer_to_platform' };

export async function investigateTransaction(db: Db, adapter: ChainAdapter, txHash: string, actor: Actor): Promise<InvestigationResult> {
  const lookup = await adapter.lookupTransaction(txHash.trim().toLowerCase());
  await recordAudit(db, actor, 'deposit.investigate', { type: 'tx', id: txHash }, { network: adapter.network.code, status: lookup.status });
  if (lookup.status === 'not_found') return { outcome: 'not_found' };
  if (lookup.status === 'pending') return { outcome: 'pending' };
  if (lookup.status === 'failed') return { outcome: 'reverted' };

  const depositIds: string[] = [];
  for (const t of lookup.transfers) {
    const r = await recordInboundTransfer(db, adapter.network.id, t, {
      isSimulated: adapter.isSimulated,
      requiredConfirmations: adapter.network.requiredConfirmations,
    });
    if (r.depositId) depositIds.push(r.depositId);
  }
  return depositIds.length ? { outcome: 'recorded', depositIds } : { outcome: 'no_transfer_to_platform' };
}
