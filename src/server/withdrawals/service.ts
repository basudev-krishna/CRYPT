/**
 * Withdrawal service.
 *
 * Accounting
 *   reserve  (user confirms):       D user_cash      C user_reserved
 *   settle   (payout confirmed):    D user_reserved  C treasury_hot (net)  C fee_revenue (fee)
 *   release  (rejected/cancelled/failed before execution): D user_reserved C user_cash
 *
 * Double-spend protection: the reservation runs in one DB transaction that
 * locks the user's cash balance row (SELECT ... FOR UPDATE) before checking it,
 * and the ledger trigger rejects any customer balance going negative. Two
 * simultaneous requests therefore serialize, and the second sees the reduced
 * balance.
 *
 * Duplicate-payout protection: each payout attempt has a deterministic custody
 * idempotency key (wd:<id>:<attempt>). Retries reuse the same key, and the
 * custody contract guarantees one transfer per key. A new attempt (new key) is
 * created only after custody reports the previous attempt dropped.
 *
 * Failure policy
 *   - custody unreachable while submitting  -> stays `processing`, retried with the same key
 *   - custody rejects before signing        -> `failed`, reservation released
 *   - transaction reverted on chain          -> `failed`, reservation released, ops alerted
 *   - transaction dropped (custody confirms) -> back to `processing`, replacement attempt
 *   - broadcast but unconfirmed              -> never settled; monitored until final
 */
import type pg from 'pg';
import { many, maybeOne, one, withTransaction, type Db } from '../db-core';
import { parseBase, parseUnits } from '@/lib/money';
import { cachedBalance, ensureAccount, lockBalance, postEntry, transfer } from '../ledger/ledger';
import { getAccountStatus, getKycStatus, type AddressScreeningProvider } from '../compliance/compliance';
import { currentPolicy, isControlEnabled, isSoleAdmin, notify, raiseRiskEvent, recordAudit, serviceActor, setControl, type Actor } from '../ops';
import { getDepositToken, getNetwork, getToken } from '../chains/registry';
import type { ChainAdapter } from '../chains/types';
import { CustodyUnavailableError, type CustodyProvider } from '../custody/types';
import { evaluatePayout, evaluateRequest, type PolicyCheck } from './policy';

export class WithdrawalError extends Error {
  override name = 'WithdrawalError';
  constructor(
    message: string,
    readonly code: string,
    readonly checks?: PolicyCheck[],
  ) {
    super(message);
  }
}

/** A reconciliation older than this no longer counts as clean for payouts (the worker runs one every 10 minutes). */
const RECONCILIATION_MAX_AGE_HOURS = 6;

const ACTIVE_STATUSES =['requested', 'pending_verification', 'reserved', 'processing', 'broadcast', 'confirmed'];

async function usage(db: Db, userId: string | null, excludeId: string | null) {
  const user = userId
    ? await one<{ total: string; recent: number }>(
        db,
        `select coalesce(sum(amount_base) filter (where created_at > now() - interval '24 hours'), 0)::text as total,
                count(*) filter (where created_at > now() - interval '1 hour')::int as recent
           from public.withdrawal_requests
          where user_id = $1 and status = any($2::public.withdrawal_status[]) and ($3::uuid is null or id <> $3)`,
        [userId, ACTIVE_STATUSES, excludeId],
      )
    : { total: '0', recent: 0 };
  const global = await one<{ total: string }>(
    db,
    `select coalesce(sum(amount_base), 0)::text as total from public.withdrawal_requests
      where created_at > now() - interval '24 hours' and status = any($1::public.withdrawal_status[]) and ($2::uuid is null or id <> $2)`,
    [ACTIVE_STATUSES, excludeId],
  );
  return { userDaily: parseBase(user.total), recent: user.recent, globalDaily: parseBase(global.total) };
}

async function isPlatformAddress(db: Db, networkId: number, address: string): Promise<boolean> {
  const r = await maybeOne<{ x: number }>(
    db,
    `select 1 as x from public.deposit_addresses where network_id = $1 and address = $2
     union all select 1 from public.treasury_wallets where network_id = $1 and address = $2 limit 1`,
    [networkId, address],
  );
  return r !== null;
}

// -----------------------------------------------------------------------------
// Request + confirmation
// -----------------------------------------------------------------------------
export interface CreateWithdrawalInput {
  userId: string;
  networkId: number;
  destination: string;
  amount: string; // decimal string as entered
  idempotencyKey: string;
  actor: Actor;
}

export async function createWithdrawal(db: Db, adapter: ChainAdapter, input: CreateWithdrawalInput) {
  const scopedKey = `${input.userId}:${input.idempotencyKey}`;
  const existing = await maybeOne<{ id: string; status: string; fee_base: string; net_amount_base: string }>(
    db,
    'select id, status, fee_base::text, net_amount_base::text from public.withdrawal_requests where idempotency_key = $1',
    [scopedKey],
  );
  if (existing) return { id: existing.id, status: existing.status, fee: parseBase(existing.fee_base), net: parseBase(existing.net_amount_base), replayed: true };

  const network = await getNetwork(db, input.networkId);
  const token = await getDepositToken(db, network.id);
  if (!token) throw new WithdrawalError('No supported token on this network', 'token_unavailable');
  const amount = parseUnits(input.amount, token.decimals);
  const addressValid = adapter.isValidAddress(input.destination);
  const destination = addressValid ? adapter.normalizeAddress(input.destination) : input.destination;

  const policy = await currentPolicy(db, 'withdrawal');
  const u = await usage(db, input.userId, null);
  const decision = evaluateRequest({
    policy: policy.params,
    amount,
    tokenMinWithdrawal: token.minWithdrawalBase,
    networkActive: network.status === 'active',
    withdrawalsPaused: await isControlEnabled(db, 'withdrawals_paused'),
    accountStatus: await getAccountStatus(db, input.userId),
    kycStatus: await getKycStatus(db, input.userId),
    addressValid,
    destinationIsDepositAddress: addressValid && (await isPlatformAddress(db, network.id, destination)),
    userDailyTotal: u.userDaily,
    globalDailyTotal: u.globalDaily,
    requestsLastHour: u.recent,
  });
  // Early, non-authoritative balance check for a clear error; the authoritative
  // check happens under the row lock in confirmWithdrawal.
  const cashNow = await cachedBalance(db, await ensureAccount(db, 'user_cash', token.id, { userId: input.userId }));
  decision.checks.push({ name: 'available_balance', result: cashNow >= amount ? 'pass' : 'fail' });
  if (cashNow < amount) decision.allowed = false;

  if (!decision.allowed) {
    const failed = decision.checks.filter((c) => c.result !== 'pass').map((c) => c.name);
    await recordAudit(db, input.actor, 'withdrawal.request_rejected', { type: 'user', id: input.userId }, { failed });
    throw new WithdrawalError(`Withdrawal not permitted: ${failed.join(', ')}`, 'policy_rejected', decision.checks);
  }

  const row = await one<{ id: string }>(
    db,
    `insert into public.withdrawal_requests
       (user_id, network_id, token_id, destination_address, amount_base, fee_base, net_amount_base, status, policy_version_id, risk_result, idempotency_key, is_simulated)
     values ($1, $2, $3, $4, $5, $6, $7, 'pending_verification', $8, $9::jsonb, $10, $11) returning id`,
    [
      input.userId,
      network.id,
      token.id,
      destination,
      amount.toString(),
      decision.fee.toString(),
      decision.net.toString(),
      policy.id,
      JSON.stringify({ request: decision.checks }),
      scopedKey,
      adapter.isSimulated,
    ],
  );
  await db.query(
    `insert into public.withdrawal_destinations (user_id, network_id, address, usable_after)
     values ($1, $2, $3, now() + make_interval(mins => $4)) on conflict (user_id, network_id, address) do nothing`,
    [input.userId, network.id, destination, policy.params.new_destination_cooldown_minutes],
  );
  await recordAudit(db, input.actor, 'withdrawal.requested', { type: 'withdrawal', id: row.id }, { amountBase: amount, destination });
  return { id: row.id, status: 'pending_verification', fee: decision.fee, net: decision.net, replayed: false };
}

/**
 * Step-up confirmation. Requires MFA (AAL2) when the policy demands it, then
 * atomically reserves the funds. Returns true if a payout job should be queued.
 */
export async function confirmWithdrawal(db: Db, args: { userId: string; withdrawalId: string; mfaVerified: boolean; actor: Actor }): Promise<{ status: string }> {
  const w = await maybeOne<{ id: string; status: string; token_id: number; amount_base: string; created_at: Date }>(
    db,
    'select id, status, token_id, amount_base::text, created_at from public.withdrawal_requests where id = $1 and user_id = $2 for update',
    [args.withdrawalId, args.userId],
  );
  if (!w) throw new WithdrawalError('Withdrawal not found', 'not_found');
  if (w.status === 'reserved' || ['processing', 'broadcast', 'confirmed'].includes(w.status)) return { status: w.status };
  if (w.status !== 'pending_verification') throw new WithdrawalError(`Withdrawal is ${w.status}`, 'invalid_state');
  if (Date.now() - new Date(w.created_at).getTime() > 15 * 60_000) {
    await db.query("update public.withdrawal_requests set status = 'cancelled', status_reason = 'confirmation expired' where id = $1", [w.id]);
    throw new WithdrawalError('Confirmation window expired; please submit a new request', 'expired');
  }

  const policy = await currentPolicy(db, 'withdrawal');
  if (policy.params.require_mfa && !args.mfaVerified) throw new WithdrawalError('Two-factor verification is required', 'mfa_required');

  const tokenId = Number(w.token_id);
  const amount = parseBase(w.amount_base);
  const cash = await ensureAccount(db, 'user_cash', tokenId, { userId: args.userId });
  const reserved = await ensureAccount(db, 'user_reserved', tokenId, { userId: args.userId });

  // Serialize with every other spend from this account, then re-check limits under the lock.
  const available = await lockBalance(db, cash);
  if (await isControlEnabled(db, 'withdrawals_paused')) throw new WithdrawalError('Withdrawals are paused', 'paused');
  const u = await usage(db, args.userId, w.id);
  if (u.userDaily + amount > policy.params.user_daily_limit_base) throw new WithdrawalError('Daily withdrawal limit reached', 'limit');
  if (available < amount) throw new WithdrawalError('Insufficient available balance', 'insufficient_balance');

  const entryId = await postEntry(db, {
    idempotencyKey: `withdrawal:${w.id}:reserve`,
    eventType: 'withdrawal_reserved',
    sourceType: 'withdrawal',
    sourceId: w.id,
    description: 'Funds reserved for withdrawal',
    postedBy: `${args.actor.type}:${args.actor.id}`,
    lines: transfer(cash, reserved, amount),
  });
  await db.query("update public.withdrawal_requests set status = 'reserved', reserve_entry_id = $2, confirmed_by_user_at = now() where id = $1", [w.id, entryId]);
  await recordAudit(db, args.actor, 'withdrawal.confirmed', { type: 'withdrawal', id: w.id }, { mfa: args.mfaVerified });
  return { status: 'reserved' };
}

async function release(db: Db, w: { id: string; user_id: string; token_id: number; amount_base: string }, reason: string, postedBy: string): Promise<string> {
  const tokenId = Number(w.token_id);
  const cash = await ensureAccount(db, 'user_cash', tokenId, { userId: w.user_id });
  const reserved = await ensureAccount(db, 'user_reserved', tokenId, { userId: w.user_id });
  const entryId = await postEntry(db, {
    idempotencyKey: `withdrawal:${w.id}:release`,
    eventType: 'withdrawal_released',
    sourceType: 'withdrawal',
    sourceId: w.id,
    description: `Reservation released: ${reason}`,
    postedBy,
    lines: transfer(reserved, cash, parseBase(w.amount_base)),
  });
  await db.query('update public.withdrawal_requests set release_entry_id = $2 where id = $1', [w.id, entryId]);
  return entryId;
}

export async function cancelWithdrawal(db: Db, args: { userId: string; withdrawalId: string; actor: Actor }): Promise<void> {
  const w = await maybeOne<{ id: string; user_id: string; status: string; token_id: number; amount_base: string }>(
    db,
    'select id, user_id, status, token_id, amount_base::text from public.withdrawal_requests where id = $1 and user_id = $2 for update',
    [args.withdrawalId, args.userId],
  );
  if (!w) throw new WithdrawalError('Withdrawal not found', 'not_found');
  if (w.status === 'pending_verification') {
    await db.query("update public.withdrawal_requests set status = 'cancelled', status_reason = 'cancelled by user' where id = $1", [w.id]);
  } else if (w.status === 'reserved') {
    await release(db, w, 'cancelled by user', `${args.actor.type}:${args.actor.id}`);
    await db.query("update public.withdrawal_requests set status = 'cancelled', status_reason = 'cancelled by user' where id = $1", [w.id]);
  } else {
    throw new WithdrawalError('This withdrawal can no longer be cancelled', 'invalid_state');
  }
  await recordAudit(db, args.actor, 'withdrawal.cancelled', { type: 'withdrawal', id: w.id });
}

// -----------------------------------------------------------------------------
// Payout processing (worker)
// -----------------------------------------------------------------------------
export interface PayoutDeps {
  custody: CustodyProvider;
  adapterFor: (networkId: number, db: Db) => Promise<ChainAdapter>;
  screening: AddressScreeningProvider;
}

interface WRow {
  id: string;
  user_id: string;
  network_id: number;
  token_id: number;
  destination_address: string;
  amount_base: string;
  fee_base: string;
  net_amount_base: string;
  status: string;
  requires_manual_review: boolean;
  compliance_hold: boolean;
  reviewed_by: string | null;
}

const W_COLS =
  'id, user_id, network_id, token_id, destination_address, amount_base::text, fee_base::text, net_amount_base::text, status, requires_manual_review, compliance_hold, reviewed_by';

async function hotWallet(db: Db, networkId: number): Promise<string> {
  const r = await maybeOne<{ address: string }>(
    db,
    "select address from public.treasury_wallets where network_id = $1 and kind = 'hot' and is_active order by id limit 1",
    [networkId],
  );
  if (!r) throw new CustodyUnavailableError('No active hot wallet configured for this network');
  return r.address;
}

export type ProcessOutcome = 'noop' | 'held' | 'manual_review' | 'rejected' | 'broadcast' | 'submitted' | 'failed';

export async function processWithdrawal(pool: pg.Pool, deps: PayoutDeps, withdrawalId: string): Promise<{ outcome: ProcessOutcome; retryAfter?: Date }> {
  const actor = serviceActor('withdrawal-processor');

  // Phase A: decide and create (or reuse) the payout attempt.
  type PhaseA = { w: WRow; key: string } | { outcome: 'noop' | 'held' | 'manual_review' | 'rejected'; retryAfter?: Date };
  const phaseA = await withTransaction(pool, async (db): Promise<PhaseA> => {
    const w = await one<WRow>(db, `select ${W_COLS} from public.withdrawal_requests where id = $1 for update`, [withdrawalId]);
    if (w.status !== 'reserved' && w.status !== 'processing') return { outcome: 'noop' as const };
    // The emergency pause and compliance holds stop every custody call, including
    // retries of an attempt already created. Retrying later reuses the same key.
    if ((await isControlEnabled(db, 'withdrawals_paused')) || w.compliance_hold) return { outcome: 'held' as const };

    if (w.status === 'processing') {
      const attempt = await maybeOne<{ custody_request_id: string }>(
        db,
        "select custody_request_id from public.withdrawal_transactions where withdrawal_id = $1 and status = 'submitted' order by attempt desc limit 1",
        [w.id],
      );
      if (attempt) return { w, key: attempt.custody_request_id };
    }

    // No live attempt: a first payout (reserved) or a replacement after a proven
    // drop (processing). Both go through the full payout policy.
    {
      const policy = await currentPolicy(db, 'withdrawal');
      const network = await getNetwork(db, Number(w.network_id));
      const token = await getToken(db, Number(w.token_id));
      const adapter = await deps.adapterFor(network.id, db);
      const dest = await one<{ usable_after: Date; first_seen_at: Date }>(
        db,
        'select usable_after, first_seen_at from public.withdrawal_destinations where user_id = $1 and network_id = $2 and address = $3',
        [w.user_id, w.network_id, w.destination_address],
      );
      const priorUse = await one<{ n: number }>(
        db,
        "select count(*)::int as n from public.withdrawal_requests where user_id = $1 and destination_address = $2 and status = 'confirmed'",
        [w.user_id, w.destination_address],
      );
      let hotAvailable: bigint | null = null;
      try {
        const hot = await hotWallet(db, network.id);
        const onchain = await adapter.getTokenBalance(token.contractAddress!, hot);
        const inflight = await one<{ s: string }>(
          db,
          "select coalesce(sum(net_amount_base), 0)::text as s from public.withdrawal_requests where network_id = $1 and status in ('processing', 'broadcast') and id <> $2",
          [network.id, w.id],
        );
        hotAvailable = onchain - parseBase(inflight.s);
      } catch {
        hotAvailable = null;
      }
      let screening = null;
      try {
        screening = await deps.screening.screen(network.code, w.destination_address);
      } catch {
        screening = null;
      }
      // The latest finished run decides; an errored or stale run is not "clean".
      const recon = await maybeOne<{ status: string; stale: boolean }>(
        db,
        `select status, finished_at < now() - make_interval(hours => ${RECONCILIATION_MAX_AGE_HOURS}) as stale
           from public.reconciliation_runs where status in ('ok', 'discrepancy', 'error') order by started_at desc, id desc limit 1`,
      );

      const result = evaluatePayout({
        policy: policy.params,
        amount: parseBase(w.amount_base),
        net: parseBase(w.net_amount_base),
        now: new Date(),
        withdrawalsPaused: await isControlEnabled(db, 'withdrawals_paused'),
        accountStatus: await getAccountStatus(db, w.user_id),
        kycStatus: await getKycStatus(db, w.user_id),
        complianceHold: w.compliance_hold,
        manuallyApproved: w.reviewed_by !== null,
        reconciliationOk: recon ? recon.status === 'ok' && !recon.stale : null,
        destination: { usableAfter: new Date(dest.usable_after), isNew: priorUse.n === 0 },
        screening,
        hotWalletAvailable: hotAvailable,
      });
      const riskResult = JSON.stringify({ payout: result.checks, decision: result.decision, policyVersion: policy.version, screening });
      await db.query('update public.withdrawal_requests set risk_result = coalesce(risk_result, $2::jsonb) || $2::jsonb where id = $1', [w.id, riskResult]);

      if (result.decision === 'reject') {
        // A replacement attempt (processing) can only end as failed; its previous attempt was proven dropped.
        const terminal = w.status === 'reserved' ? 'rejected' : 'failed';
        await release(db, w, 'rejected by payout policy', `${actor.type}:${actor.id}`);
        await db.query("update public.withdrawal_requests set status = $2::public.withdrawal_status, status_reason = 'payout policy' where id = $1", [w.id, terminal]);
        await raiseRiskEvent(db, { userId: w.user_id, kind: 'withdrawal_rejected', severity: 'high', subjectType: 'withdrawal', subjectId: w.id, details: { checks: result.checks } });
        await notify(db, { userId: w.user_id, kind: 'withdrawal_rejected', payload: { withdrawalId: w.id }, dedupeKey: `wd_rejected:${w.id}` });
        return { outcome: 'rejected' as const };
      }
      if (result.decision === 'hold') return result.retryAfter ? { outcome: 'held', retryAfter: result.retryAfter } : { outcome: 'held' };
      if (result.decision === 'manual_review') {
        // Staff review only applies to reserved withdrawals.
        if (w.status === 'processing') await db.query("update public.withdrawal_requests set status = 'reserved' where id = $1", [w.id]);
        if (!w.requires_manual_review) {
          await db.query('update public.withdrawal_requests set requires_manual_review = true where id = $1', [w.id]);
          await raiseRiskEvent(db, { userId: w.user_id, kind: 'withdrawal_manual_review', severity: 'medium', subjectType: 'withdrawal', subjectId: w.id, details: { checks: result.checks } });
          await notify(db, { audience: 'operations', kind: 'withdrawal_review_required', payload: { withdrawalId: w.id } });
        }
        return { outcome: 'manual_review' as const };
      }
    }

    const next = await one<{ n: number }>(db, 'select coalesce(max(attempt), 0)::int + 1 as n from public.withdrawal_transactions where withdrawal_id = $1', [w.id]);
    const key = `wd:${w.id}:${next.n}`;
    await db.query(
      `insert into public.withdrawal_transactions (withdrawal_id, attempt, custody_provider, custody_request_id, status, is_simulated)
       values ($1, $2, $3, $4, 'submitted', $5)`,
      [w.id, next.n, deps.custody.name, key, deps.custody.isSimulated],
    );
    if (w.status === 'reserved') await db.query("update public.withdrawal_requests set status = 'processing' where id = $1", [w.id]);
    await recordAudit(db, actor, 'withdrawal.payout_submitted', { type: 'withdrawal', id: w.id }, { attempt: next.n, key });
    return { w, key };
  });
  if ('outcome' in phaseA) return phaseA;

  // Phase B: call custody outside any DB transaction. Same key on every retry.
  const { w, key } = phaseA;
  const network = await getNetwork(pool, Number(w.network_id));
  const token = await getToken(pool, Number(w.token_id));
  const from = await hotWallet(pool, network.id);
  const result = await deps.custody.submitTransfer({
    idempotencyKey: key,
    networkId: network.id,
    networkCode: network.code,
    tokenContract: token.contractAddress!,
    fromAddress: from,
    toAddress: w.destination_address,
    amount: parseBase(w.net_amount_base),
  });

  // Phase C: record the custody result.
  return withTransaction(pool, async (db) => {
    await db.query('select 1 from public.withdrawal_requests where id = $1 for update', [w.id]);
    await db.query(
      `update public.withdrawal_transactions set custody_tx_id = $2, tx_hash = $3, status = $4, fee_native_base = $5, error = $6 where custody_request_id = $1`,
      [key, result.custodyTxId, result.txHash, result.status === 'failed' ? 'failed' : result.status === 'submitted' ? 'submitted' : 'broadcast', result.feeNative?.toString() ?? null, result.error ?? null],
    );
    if (result.status === 'failed') {
      await release(db, w, `custody rejected: ${result.error ?? 'unknown'}`, `${actor.type}:${actor.id}`);
      await db.query("update public.withdrawal_requests set status = 'failed', status_reason = $2 where id = $1", [w.id, result.error ?? 'custody rejected']);
      await raiseRiskEvent(db, { userId: w.user_id, kind: 'payout_failed', severity: 'high', subjectType: 'withdrawal', subjectId: w.id, details: { error: result.error } });
      return { outcome: 'failed' as const };
    }
    if (result.status === 'submitted') return { outcome: 'submitted' as const };
    await db.query("update public.withdrawal_requests set status = 'broadcast' where id = $1 and status = 'processing'", [w.id]);
    await notify(db, { userId: w.user_id, kind: 'withdrawal_broadcast', payload: { withdrawalId: w.id, txHash: result.txHash }, dedupeKey: `wd_broadcast:${w.id}:${key}` });
    return { outcome: 'broadcast' as const };
  });
}

/** Critical payout anomaly: one open risk event per withdrawal and kind, and an automatic pause of all payouts. */
async function escalatePayoutAnomaly(db: Db, w: WRow, kind: string, details: Record<string, unknown>): Promise<void> {
  const open = await maybeOne<{ id: string }>(
    db,
    "select id from public.risk_events where kind = $1 and subject_type = 'withdrawal' and subject_id = $2 and status <> 'resolved' limit 1",
    [kind, w.id],
  );
  if (open) return;
  await raiseRiskEvent(db, { userId: w.user_id, kind, severity: 'critical', subjectType: 'withdrawal', subjectId: w.id, details });
  if (!(await isControlEnabled(db, 'withdrawals_paused'))) {
    await setControl(db, 'withdrawals_paused', true, `Automatic pause: ${kind} on withdrawal ${w.id}`, serviceActor('withdrawal-monitor'));
  }
}

export type MonitorOutcome ='noop' | 'pending' | 'confirmed' | 'failed' | 'replaced';

const DROP_TIMEOUT_MS = 30 * 60_000;

export async function monitorWithdrawal(pool: pg.Pool, deps: PayoutDeps, withdrawalId: string): Promise<MonitorOutcome> {
  const actor = serviceActor('withdrawal-monitor');
  const snapshot = await maybeOne<WRow & { tx_hash: string | null; custody_tx_id: string | null; attempt_created: Date; attempt_id: string }>(
    pool,
    `select ${W_COLS.split(', ').map((c) => `w.${c}`).join(', ')}, t.tx_hash, t.custody_tx_id, t.created_at as attempt_created, t.id as attempt_id
       from public.withdrawal_requests w join public.withdrawal_transactions t on t.withdrawal_id = w.id and t.status = 'broadcast'
      where w.id = $1 and w.status = 'broadcast'`,
    [withdrawalId],
  );
  if (!snapshot || !snapshot.custody_tx_id) return 'noop';
  const network = await getNetwork(pool, Number(snapshot.network_id));
  const custodyView = await deps.custody.getTransfer(snapshot.custody_tx_id, network.id);

  const token = await getToken(pool, Number(snapshot.token_id));
  let confirmations = 0;
  let chainStatus: 'pending' | 'success' | 'failed' | 'not_found' = 'pending';
  let paysDestination = false;
  if (snapshot.tx_hash) {
    const adapter = await deps.adapterFor(network.id, pool);
    const lookup = await adapter.lookupTransaction(snapshot.tx_hash);
    chainStatus = lookup.status;
    if (lookup.status === 'success' || lookup.status === 'failed') confirmations = lookup.confirmations;
    // A successful receipt only settles the withdrawal if it actually moved the
    // net amount of the withdrawn token from our hot wallet to the requested
    // destination. (With manual custody the hash is typed in by a person, so a
    // transfer from some other wallet must never count as our payout.)
    if (lookup.status === 'success') {
      const net = parseBase(snapshot.net_amount_base);
      const from = (await hotWallet(pool, network.id)).toLowerCase();
      paysDestination = lookup.transfers.some(
        (t) =>
          t.tokenContract === token.contractAddress?.toLowerCase() &&
          t.from === from &&
          t.to === snapshot.destination_address.toLowerCase() &&
          t.amount === net,
      );
    }
  }
  const custodyFailed = custodyView?.status === 'failed';

  return withTransaction(pool, async (db) => {
    const w = await one<WRow>(db, `select ${W_COLS} from public.withdrawal_requests where id = $1 for update`, [withdrawalId]);
    if (w.status !== 'broadcast') return 'noop' as const;
    await db.query('update public.withdrawal_transactions set confirmations = $2 where id = $1', [snapshot.attempt_id, confirmations]);

    // Custody and chain disagree, or the mined transfer is not the payout we asked
    // for. Never release (funds may have left) and never settle: stop payouts and
    // escalate to operations.
    if (chainStatus === 'success' && (custodyFailed || !paysDestination)) {
      const kind = custodyFailed ? 'payout_status_conflict' : 'payout_verification_mismatch';
      await escalatePayoutAnomaly(db, w, kind, { txHash: snapshot.tx_hash, custodyStatus: custodyView?.status ?? null, paysDestination });
      return 'pending' as const;
    }

    // Release only when the payout is proven not executed: reverted on chain, or
    // custody reports failure and nothing is (or could be) on chain.
    if (chainStatus === 'failed' || (custodyFailed && (chainStatus === 'not_found' || !snapshot.tx_hash))) {
      await db.query("update public.withdrawal_transactions set status = 'failed', error = 'reverted on chain' where id = $1", [snapshot.attempt_id]);
      await release(db, w, 'payout transaction reverted', `${actor.type}:${actor.id}`);
      await db.query("update public.withdrawal_requests set status = 'failed', status_reason = 'payout transaction reverted on chain' where id = $1", [w.id]);
      await raiseRiskEvent(db, { userId: w.user_id, kind: 'payout_reverted', severity: 'high', subjectType: 'withdrawal', subjectId: w.id, details: { txHash: snapshot.tx_hash } });
      await notify(db, { userId: w.user_id, kind: 'withdrawal_failed', payload: { withdrawalId: w.id }, dedupeKey: `wd_failed:${w.id}` });
      return 'failed' as const;
    }

    if (chainStatus === 'success' && confirmations >= network.requiredConfirmations) {
      const tokenId = Number(w.token_id);
      const reserved = await ensureAccount(db, 'user_reserved', tokenId, { userId: w.user_id });
      const treasury = await ensureAccount(db, 'treasury_hot', tokenId);
      const fee = parseBase(w.fee_base);
      const lines = [
        { accountId: reserved, direction: 'D' as const, amount: parseBase(w.amount_base) },
        { accountId: treasury, direction: 'C' as const, amount: parseBase(w.net_amount_base), memo: 'sent on chain' },
      ];
      if (fee > 0n) lines.push({ accountId: await ensureAccount(db, 'fee_revenue', tokenId), direction: 'C' as const, amount: fee, memo: 'withdrawal fee' });
      const entryId = await postEntry(db, {
        idempotencyKey: `withdrawal:${w.id}:settle`,
        eventType: 'withdrawal_settled',
        sourceType: 'withdrawal',
        sourceId: w.id,
        description: `Withdrawal settled ${snapshot.tx_hash}`,
        postedBy: `${actor.type}:${actor.id}`,
        lines,
        metadata: { txHash: snapshot.tx_hash, confirmations },
      });
      await db.query("update public.withdrawal_transactions set status = 'confirmed' where id = $1", [snapshot.attempt_id]);
      await db.query("update public.withdrawal_requests set status = 'confirmed', settle_entry_id = $2 where id = $1", [w.id, entryId]);
      await db.query('update public.withdrawal_destinations set verified_at = coalesce(verified_at, now()) where user_id = $1 and network_id = $2 and address = $3', [
        w.user_id,
        w.network_id,
        w.destination_address,
      ]);
      await recordAudit(db, actor, 'withdrawal.settled', { type: 'withdrawal', id: w.id }, { entryId, txHash: snapshot.tx_hash });
      await notify(db, { userId: w.user_id, kind: 'withdrawal_confirmed', payload: { withdrawalId: w.id, txHash: snapshot.tx_hash }, dedupeKey: `wd_confirmed:${w.id}` });
      return 'confirmed' as const;
    }

    // Dropped: custody has no record / says dropped, nothing on chain, past the timeout.
    const timedOut = Date.now() - new Date(snapshot.attempt_created).getTime() > DROP_TIMEOUT_MS;
    if ((custodyView?.status === 'dropped' || (custodyView === null && timedOut)) && chainStatus === 'not_found') {
      await db.query("update public.withdrawal_transactions set status = 'dropped' where id = $1", [snapshot.attempt_id]);
      await db.query("update public.withdrawal_requests set status = 'processing' where id = $1", [w.id]);
      await raiseRiskEvent(db, { userId: w.user_id, kind: 'payout_dropped', severity: 'medium', subjectType: 'withdrawal', subjectId: w.id, details: { txHash: snapshot.tx_hash } });
      return 'replaced' as const;
    }
    return 'pending' as const;
  });
}

// -----------------------------------------------------------------------------
// Staff actions
// -----------------------------------------------------------------------------
export async function reviewWithdrawal(db: Db, args: { withdrawalId: string; decision: 'approve' | 'reject'; note: string; staffUserId: string; actor: Actor }): Promise<void> {
  if (args.note.trim().length < 10) throw new WithdrawalError('A review note of at least 10 characters is required', 'note_required');
  const w = await one<WRow>(db, `select ${W_COLS} from public.withdrawal_requests where id = $1 for update`, [args.withdrawalId]);
  if (w.status !== 'reserved') throw new WithdrawalError(`Withdrawal is ${w.status}`, 'invalid_state');
  if (w.user_id === args.staffUserId) {
    if (!(await isSoleAdmin(db, args.staffUserId))) throw new WithdrawalError('Staff cannot review their own withdrawal', 'conflict_of_interest');
    await raiseRiskEvent(db, { userId: w.user_id, kind: 'admin_self_review', severity: 'high', subjectType: 'withdrawal', subjectId: w.id, details: { decision: args.decision, note: args.note } });
  }
  if (args.decision === 'approve') {
    await db.query('update public.withdrawal_requests set reviewed_by = $2, reviewed_at = now() where id = $1', [w.id, args.staffUserId]);
  } else {
    await release(db, w, `rejected in review: ${args.note}`, `${args.actor.type}:${args.actor.id}`);
    await db.query("update public.withdrawal_requests set status = 'rejected', status_reason = $2, reviewed_by = $3, reviewed_at = now() where id = $1", [
      w.id,
      args.note,
      args.staffUserId,
    ]);
    await notify(db, { userId: w.user_id, kind: 'withdrawal_rejected', payload: { withdrawalId: w.id }, dedupeKey: `wd_rejected:${w.id}` });
  }
  await recordAudit(db, args.actor, `withdrawal.review_${args.decision}`, { type: 'withdrawal', id: w.id }, { note: args.note });
}

export async function setComplianceHold(db: Db, args: { withdrawalId: string; hold: boolean; note: string; actor: Actor }): Promise<void> {
  if (args.note.trim().length < 10) throw new WithdrawalError('A note of at least 10 characters is required', 'note_required');
  const res = await db.query("update public.withdrawal_requests set compliance_hold = $2 where id = $1 and status in ('pending_verification', 'reserved')", [
    args.withdrawalId,
    args.hold,
  ]);
  if (res.rowCount !== 1) throw new WithdrawalError('Hold can only be changed before processing starts', 'invalid_state');
  await recordAudit(db, args.actor, args.hold ? 'withdrawal.compliance_hold' : 'withdrawal.compliance_release', { type: 'withdrawal', id: args.withdrawalId }, { note: args.note });
}

/** Withdrawals awaiting confirmation for more than 15 minutes are cancelled (nothing was reserved). */
export async function expireUnconfirmed(db: Db): Promise<number> {
  const res = await db.query(
    "update public.withdrawal_requests set status = 'cancelled', status_reason = 'confirmation expired' where status = 'pending_verification' and created_at < now() - interval '15 minutes'",
  );
  return res.rowCount ?? 0;
}

export async function listOpenWithdrawalIds(db: Db, status: 'reserved' | 'processing' | 'broadcast'): Promise<string[]> {
  const rows = await many<{ id: string }>(
    db,
    'select id from public.withdrawal_requests where status = $1 and not compliance_hold order by created_at limit 200',
    [status],
  );
  return rows.map((r) => r.id);
}
