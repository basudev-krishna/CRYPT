/**
 * Administrator allocations and corrections for group-wallet receipts.
 *
 * Accounting
 *   allocate (worker):  D suspense_deposits (receipt amount)  C user_cash (one line per member)
 *   referral fund:      D suspense_deposits (receipt amount)  C referral_reward_fund (operator money)
 *   operator float:     D suspense_deposits (receipt amount)  C operator_float (backs manual adjustments)
 *   correct  (worker):  ledger.reverse_entry of the deposit's credit entry, back into suspense
 *
 * An allocation must spend an unattributed receipt that is already received into
 * suspense, and its lines must add up to exactly the receipt amount. So the
 * ledger can never credit members more than the group wallet actually received.
 *
 * The web role records the request; the worker posts it. With a single
 * administrator there is no second approver, so every request needs a written
 * reason and raises a high-severity risk event (sent to Telegram), and each
 * affected member is notified with that reason.
 */
import { many, maybeOne, one, type Db } from '../db-core';
import { parseBase, parseUnits } from '@/lib/money';
import { ensureAccount, postEntry, type LedgerLine } from '../ledger/ledger';
import { getAccountStatus } from '../compliance/compliance';
import { isControlEnabled, notify, raiseRiskEvent, recordAudit, type Actor } from '../ops';
import { getToken } from '../chains/registry';

export class AllocationError extends Error {
  override name = 'AllocationError';
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

const MIN_REASON = 10;

interface DepositForAllocation {
  id: string;
  user_id: string | null;
  token_id: number | null;
  amount_base: string;
  status: string;
  status_reason: string | null;
  suspense_entry_id: string | null;
  credit_entry_id: string | null;
}

async function lockDeposit(db: Db, depositId: string): Promise<DepositForAllocation> {
  const d = await maybeOne<DepositForAllocation>(
    db,
    `select id, user_id, token_id, amount_base::text, status, status_reason, suspense_entry_id, credit_entry_id
       from public.deposits where id = $1 for update`,
    [depositId],
  );
  if (!d) throw new AllocationError('Deposit not found', 'not_found');
  return d;
}

/** Why a receipt cannot be allocated right now, or null if it can. */
function unallocatable(d: DepositForAllocation): string | null {
  if (d.status !== 'under_review') return `deposit is ${d.status}`;
  if (d.user_id !== null) return 'deposit already belongs to a member; use the deposit review instead';
  if (d.token_id === null) return 'deposit is not in a supported token';
  if (d.suspense_entry_id === null) return 'deposit has not been received into suspense yet';
  if (d.credit_entry_id !== null) return 'deposit is already credited';
  return null;
}

export interface AllocationLineInput {
  userId: string;
  amount: string; // decimal string as entered
}

export type AllocationKind = 'assignment' | 'distribution' | 'referral_fund' | 'operator_float';

/** Operator top-ups: the whole receipt goes to one operator account, with no member lines. */
const FUND_PURPOSE = { referral_fund: 'referral_reward_fund', operator_float: 'operator_float' } as const;
const isFundKind = (k: AllocationKind): k is keyof typeof FUND_PURPOSE => k in FUND_PURPOSE;

/**
 * Record an allocation of an unattributed receipt. Pure validation of the
 * split: lines are per distinct member and add up exactly to the receipt.
 * An operator top-up has no member lines: the whole receipt goes to the fund.
 */
export function validateSplit(kind: AllocationKind, receipt: bigint, lines: { userId: string; amount: bigint }[]): string | null {
  if (isFundKind(kind)) return lines.length === 0 ? null : 'An operator top-up has no member lines';
  if (lines.length === 0) return 'Add at least one member';
  if (kind === 'assignment' && lines.length !== 1) return 'An assignment goes to exactly one member';
  if (new Set(lines.map((l) => l.userId)).size !== lines.length) return 'Each member may appear only once';
  if (lines.some((l) => l.amount <= 0n)) return 'Every amount must be positive';
  const total = lines.reduce((s, l) => s + l.amount, 0n);
  if (total !== receipt) return 'The amounts must add up exactly to the amount received';
  return null;
}

export async function createAllocation(
  db: Db,
  args: { depositId: string; kind: AllocationKind; reason: string; lines: AllocationLineInput[]; staffUserId: string; actor: Actor },
): Promise<{ id: string }> {
  const reason = args.reason.trim();
  if (reason.length < MIN_REASON) throw new AllocationError(`A reason of at least ${MIN_REASON} characters is required`, 'reason_required');

  const d = await lockDeposit(db, args.depositId);
  const blocked = unallocatable(d);
  if (blocked) throw new AllocationError(`This deposit cannot be allocated: ${blocked}`, 'invalid_state');
  const live = await maybeOne<{ id: string }>(db, "select id from public.allocations where deposit_id = $1 and status in ('pending', 'posted')", [d.id]);
  if (live) throw new AllocationError('This deposit already has an allocation', 'already_allocated');

  const token = await getToken(db, Number(d.token_id));
  const lines = args.lines.map((l) => ({ userId: l.userId, amount: parseUnits(l.amount, token.decimals) }));
  const invalid = validateSplit(args.kind, parseBase(d.amount_base), lines);
  if (invalid) throw new AllocationError(invalid, 'invalid_split');
  for (const l of lines) {
    if ((await getAccountStatus(db, l.userId)) !== 'active') throw new AllocationError('Every recipient must be an active member', 'recipient_not_active');
  }

  const row = await one<{ id: string }>(
    db,
    'insert into public.allocations (deposit_id, kind, reason, created_by) values ($1, $2, $3, $4) returning id',
    [d.id, args.kind, reason, args.staffUserId],
  );
  for (const l of lines) {
    await db.query('insert into public.allocation_lines (allocation_id, user_id, amount_base) values ($1, $2, $3)', [row.id, l.userId, l.amount.toString()]);
  }
  const toSelf = lines.some((l) => l.userId === args.staffUserId);
  const details = { depositId: d.id, kind: args.kind, reason, recipients: lines.length, amountBase: d.amount_base, toSelf };
  await recordAudit(db, args.actor, 'deposit.allocation_created', { type: 'allocation', id: row.id }, details);
  // With one administrator, visibility is the control: every allocation is alerted, self-allocations by name.
  await raiseRiskEvent(db, { kind: toSelf ? 'admin_self_allocation' : 'admin_allocation', severity: 'high', subjectType: 'allocation', subjectId: row.id, details });
  return row;
}

export async function cancelAllocation(db: Db, args: { allocationId: string; reason: string; actor: Actor }): Promise<void> {
  if (args.reason.trim().length < MIN_REASON) throw new AllocationError(`A reason of at least ${MIN_REASON} characters is required`, 'reason_required');
  const res = await db.query("update public.allocations set status = 'cancelled', error = $2 where id = $1 and status = 'pending'", [args.allocationId, `cancelled: ${args.reason.trim()}`]);
  if (res.rowCount !== 1) throw new AllocationError('Only a pending allocation can be cancelled', 'invalid_state');
  await recordAudit(db, args.actor, 'deposit.allocation_cancelled', { type: 'allocation', id: args.allocationId }, { reason: args.reason.trim() });
}

export type PostOutcome = 'posted' | 'deferred' | 'failed' | 'unchanged';

/** Worker: post a pending allocation. Idempotent (deterministic ledger key, status check under lock). */
export async function postAllocation(db: Db, allocationId: string, actor: Actor): Promise<PostOutcome> {
  const a = await maybeOne<{ id: string; deposit_id: string; kind: string; reason: string; status: string }>(
    db,
    'select id, deposit_id, kind, reason, status from public.allocations where id = $1 for update',
    [allocationId],
  );
  if (!a || a.status !== 'pending') return 'unchanged';
  if (await isControlEnabled(db, 'allocations_paused')) return 'deferred';

  const d = await lockDeposit(db, a.deposit_id);
  const lines = await many<{ user_id: string; amount_base: string }>(db, 'select user_id, amount_base::text from public.allocation_lines where allocation_id = $1 order by user_id', [a.id]);
  const parsed = lines.map((l) => ({ userId: l.user_id, amount: parseBase(l.amount_base) }));
  const problem = unallocatable(d) ?? validateSplit(a.kind as AllocationKind, parseBase(d.amount_base), parsed);
  if (problem) {
    await db.query("update public.allocations set status = 'failed', error = $2 where id = $1", [a.id, problem]);
    await raiseRiskEvent(db, { kind: 'allocation_failed', severity: 'medium', subjectType: 'allocation', subjectId: a.id, details: { problem } });
    return 'failed';
  }

  const tokenId = Number(d.token_id);
  const suspense = await ensureAccount(db, 'suspense_deposits', tokenId);
  const entryLines: LedgerLine[] = [{ accountId: suspense, direction: 'D', amount: parseBase(d.amount_base) }];
  const kind = a.kind as AllocationKind;
  if (isFundKind(kind)) {
    entryLines.push({ accountId: await ensureAccount(db, FUND_PURPOSE[kind], tokenId), direction: 'C', amount: parseBase(d.amount_base) });
  }
  for (const l of parsed) {
    entryLines.push({ accountId: await ensureAccount(db, 'user_cash', tokenId, { userId: l.userId }), direction: 'C', amount: l.amount });
  }
  const label = {
    assignment: 'Deposit assigned by administrator',
    distribution: 'Distribution by administrator',
    referral_fund: 'Referral reward fund top-up',
    operator_float: 'Operator float top-up',
  }[kind];
  const entryId = await postEntry(db, {
    idempotencyKey: `allocation:${a.id}`,
    eventType: 'deposit_allocated',
    sourceType: 'allocation',
    sourceId: a.id,
    description: `${label}: ${a.reason}`,
    postedBy: `${actor.type}:${actor.id}`,
    lines: entryLines,
    metadata: { depositId: d.id, kind: a.kind },
  });

  await db.query("update public.allocations set status = 'posted', entry_id = $2, posted_at = now(), error = null where id = $1", [a.id, entryId]);
  await db.query(
    `update public.deposits set status = 'credited', status_reason = null, credit_entry_id = $2, credited_at = now(),
            user_id = case when $3::text = 'assignment' then $4::uuid else user_id end
      where id = $1`,
    [d.id, entryId, a.kind, parsed[0]?.userId ?? null],
  );
  for (const l of parsed) {
    await notify(db, {
      userId: l.userId,
      kind: a.kind === 'assignment' ? 'deposit_assigned' : 'distribution_received',
      payload: { allocationId: a.id, amountBase: l.amount.toString(), reason: a.reason },
      dedupeKey: `allocation:${a.id}:${l.userId}`,
    });
  }
  await recordAudit(db, actor, 'deposit.allocation_posted', { type: 'allocation', id: a.id }, { entryId });
  return 'posted';
}

/** Request reversal of a credited deposit back into suspense, so it can be allocated again. */
export async function createCorrection(db: Db, args: { depositId: string; reason: string; staffUserId: string; actor: Actor }): Promise<{ id: string }> {
  const reason = args.reason.trim();
  if (reason.length < MIN_REASON) throw new AllocationError(`A reason of at least ${MIN_REASON} characters is required`, 'reason_required');
  const d = await lockDeposit(db, args.depositId);
  if (d.status !== 'credited' || d.credit_entry_id === null) throw new AllocationError('Only a credited deposit can be corrected', 'invalid_state');
  const live = await maybeOne<{ id: string }>(
    db,
    "select id from public.deposit_corrections where reversed_entry_id = $1 and status in ('pending', 'posted')",
    [d.credit_entry_id],
  );
  if (live) throw new AllocationError('A correction for this deposit is already in progress', 'already_corrected');
  const row = await one<{ id: string }>(
    db,
    'insert into public.deposit_corrections (deposit_id, reversed_entry_id, reason, created_by) values ($1, $2, $3, $4) returning id',
    [d.id, d.credit_entry_id, reason, args.staffUserId],
  );
  const details = { depositId: d.id, reversedEntryId: d.credit_entry_id, reason, amountBase: d.amount_base };
  await recordAudit(db, args.actor, 'deposit.correction_created', { type: 'deposit_correction', id: row.id }, details);
  await raiseRiskEvent(db, { kind: 'admin_correction', severity: 'high', subjectType: 'deposit_correction', subjectId: row.id, details });
  return row;
}

/**
 * Worker: reverse the credit. Fails (throws) if a member no longer holds the
 * credited cash, because customer balances can never go negative; the caller
 * then records the failure. Idempotent: reversals are keyed by entry id.
 */
export async function postCorrection(db: Db, correctionId: string, actor: Actor): Promise<PostOutcome> {
  const c = await maybeOne<{ id: string; deposit_id: string; reversed_entry_id: string; reason: string; status: string }>(
    db,
    'select id, deposit_id, reversed_entry_id, reason, status from public.deposit_corrections where id = $1 for update',
    [correctionId],
  );
  if (!c || c.status !== 'pending') return 'unchanged';
  const d = await lockDeposit(db, c.deposit_id);
  if (d.status !== 'credited' || d.credit_entry_id !== c.reversed_entry_id) {
    await db.query("update public.deposit_corrections set status = 'failed', error = 'deposit changed since the correction was requested' where id = $1", [c.id]);
    return 'failed';
  }

  const affected = await many<{ user_id: string; amount: string }>(
    db,
    `select a.user_id, l.amount::text from public.journal_lines l join public.ledger_accounts a on a.id = l.account_id
      where l.entry_id = $1 and a.purpose = 'user_cash' and a.user_id is not null`,
    [c.reversed_entry_id],
  );
  const rev = await one<{ id: string }>(db, 'select ledger.reverse_entry($1, $2, $3) as id', [c.reversed_entry_id, `Correction: ${c.reason}`, `${actor.type}:${actor.id}`]);

  await db.query("update public.deposit_corrections set status = 'posted', reversal_entry_id = $2, error = null where id = $1", [c.id, rev.id]);
  await db.query("update public.allocations set status = 'reversed' where entry_id = $1 and status = 'posted'", [c.reversed_entry_id]);
  await db.query(
    `update public.deposits set status = 'under_review', status_reason = 'corrected', user_id = null, member_wallet_id = null,
            credit_entry_id = null, credited_at = null
      where id = $1`,
    [d.id],
  );
  for (const u of affected) {
    await notify(db, {
      userId: u.user_id,
      kind: 'deposit_corrected',
      payload: { depositId: d.id, amountBase: u.amount, reason: c.reason },
      dedupeKey: `correction:${c.id}:${u.user_id}`,
    });
  }
  await recordAudit(db, actor, 'deposit.correction_posted', { type: 'deposit_correction', id: c.id }, { reversalEntryId: rev.id });
  return 'posted';
}

/** Worker: record why a correction could not be posted (runs in its own transaction). */
export async function failCorrection(db: Db, correctionId: string, error: string): Promise<void> {
  const res = await db.query("update public.deposit_corrections set status = 'failed', error = $2 where id = $1 and status = 'pending'", [correctionId, error.slice(0, 500)]);
  if (res.rowCount === 1) {
    await raiseRiskEvent(db, { kind: 'correction_failed', severity: 'high', subjectType: 'deposit_correction', subjectId: correctionId, details: { error: error.slice(0, 500) } });
  }
}

export async function listPendingAllocationIds(db: Db): Promise<string[]> {
  return (await many<{ id: string }>(db, "select id from public.allocations where status = 'pending' order by created_at limit 100")).map((r) => r.id);
}

export async function listPendingCorrectionIds(db: Db): Promise<string[]> {
  return (await many<{ id: string }>(db, "select id from public.deposit_corrections where status = 'pending' order by created_at limit 100")).map((r) => r.id);
}
