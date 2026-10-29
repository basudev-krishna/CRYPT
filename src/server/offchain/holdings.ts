/**
 * Off-platform holdings: money members handed the administrator personally.
 *
 * A memo ledger kept apart from the double-entry ledger, because the money is
 * in no platform wallet (see the migration *_offchain_holdings.sql). It is never
 * withdrawable on the site. Moving it on the platform is an ordinary group-wallet
 * receipt assigned to the member, matched here by a 'moved_to_platform' entry
 * bound to that allocation for exactly the same amount.
 *
 * Entries are append-only and corrected only by reversal. With one
 * administrator there is no second approver, so every entry needs a written
 * reason, is audited, raises a high-severity risk event, and is visible to the
 * linked member.
 */
import { many, maybeOne, one, type Db } from '../db-core';
import { formatUnits, parseBase, parseUnits } from '@/lib/money';
import { notify, raiseRiskEvent, recordAudit, type Actor } from '../ops';

export class OffchainError extends Error {
  override name = 'OffchainError';
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/** Amounts are micro-USDT: 6 decimals. */
export const MICRO_DECIMALS = 6;
const MIN_REASON = 10;

export type ManualKind = 'contribution' | 'earnings' | 'payback' | 'adjustment';
export type EntryKind = ManualKind | 'moved_to_platform' | 'reversal';
/** Optional tag on an earnings entry, so the member sees it in the right place. */
export type EntryCategory = 'matching_bonus';

/**
 * Signed micro amount for a manual entry. Contributions and earnings add,
 * paybacks subtract; an adjustment takes its sign from the input ("-5" or "5").
 */
export function signedMicro(kind: ManualKind, amount: string): bigint {
  const trimmed = amount.trim();
  const negative = trimmed.startsWith('-');
  if (negative && kind !== 'adjustment') throw new OffchainError('Enter a positive amount; the entry type sets the direction', 'invalid_amount');
  const value = parseUnits(negative ? trimmed.slice(1) : trimmed, MICRO_DECIMALS);
  if (value <= 0n) throw new OffchainError('The amount must not be zero', 'invalid_amount');
  if (kind === 'payback') return -value;
  if (kind === 'adjustment' && negative) return -value;
  return value;
}

/** Micro-USDT → token base units (for adding a held balance to a token-denominated total). */
export function microToBase(micro: bigint, decimals: number): bigint {
  return decimals >= MICRO_DECIMALS ? micro * 10n ** BigInt(decimals - MICRO_DECIMALS) : micro / 10n ** BigInt(MICRO_DECIMALS - decimals);
}

/** Token base units → micro-USDT, refusing any amount that would lose precision. */
export function baseToMicro(amountBase: bigint, decimals: number): bigint {
  if (decimals === MICRO_DECIMALS) return amountBase;
  if (decimals < MICRO_DECIMALS) return amountBase * 10n ** BigInt(MICRO_DECIMALS - decimals);
  const factor = 10n ** BigInt(decimals - MICRO_DECIMALS);
  if (amountBase % factor !== 0n) throw new OffchainError('That receipt has more than 6 decimal places and cannot be matched exactly', 'inexact_amount');
  return amountBase / factor;
}

const requireReason = (reason: string) => {
  if (reason.trim().length < MIN_REASON) throw new OffchainError(`A reason of at least ${MIN_REASON} characters is required`, 'reason_required');
  return reason.trim();
};

interface Holder {
  id: string;
  name: string;
  user_id: string | null;
}

async function lockHolder(db: Db, holderId: string): Promise<Holder> {
  const h = await maybeOne<Holder>(db, 'select id, name, user_id from public.offchain_holders where id = $1 for update', [holderId]);
  if (!h) throw new OffchainError('Holder not found', 'not_found');
  return h;
}

export async function offchainBalance(db: Db, holderId: string): Promise<bigint> {
  const r = await one<{ b: string }>(db, 'select coalesce(sum(amount_micro), 0)::text as b from public.offchain_entries where holder_id = $1', [holderId]);
  return parseBase(r.b);
}

export async function createHolder(db: Db, args: { name: string; note?: string | null; staffUserId: string; actor: Actor }): Promise<{ id: string }> {
  const name = args.name.trim();
  if (name.length < 2 || name.length > 80) throw new OffchainError('Names are 2 to 80 characters', 'invalid_name');
  const row = await one<{ id: string }>(db, 'insert into public.offchain_holders (name, note, created_by) values ($1, $2, $3) returning id', [
    name,
    args.note?.trim() || null,
    args.staffUserId,
  ]);
  await recordAudit(db, args.actor, 'offchain.holder_created', { type: 'offchain_holder', id: row.id }, { name, note: args.note?.trim() || null });
  return row;
}

export async function updateHolder(db: Db, args: { holderId: string; name: string; note?: string | null; actor: Actor }): Promise<void> {
  const name = args.name.trim();
  if (name.length < 2 || name.length > 80) throw new OffchainError('Names are 2 to 80 characters', 'invalid_name');
  const before = await one<{ name: string; note: string | null }>(db, 'select name, note from public.offchain_holders where id = $1 for update', [args.holderId]);
  await db.query('update public.offchain_holders set name = $2, note = $3 where id = $1', [args.holderId, name, args.note?.trim() || null]);
  await recordAudit(db, args.actor, 'offchain.holder_updated', { type: 'offchain_holder', id: args.holderId }, { before, after: { name, note: args.note?.trim() || null } });
}

/** Link a holder to a member account, once. The member then sees the balance and history. */
export async function linkHolder(db: Db, args: { holderId: string; memberCode: string; staffUserId: string; actor: Actor }): Promise<void> {
  const h = await lockHolder(db, args.holderId);
  if (h.user_id) throw new OffchainError('This holder is already linked to an account', 'already_linked');
  const member = await maybeOne<{ user_id: string }>(db, "select user_id from public.user_profiles where member_code = $1 and account_status = 'active'", [
    args.memberCode.trim().toUpperCase(),
  ]);
  if (!member) throw new OffchainError('No active member has that member id', 'member_not_found');
  if (await maybeOne(db, 'select 1 from public.offchain_holders where user_id = $1', [member.user_id])) {
    throw new OffchainError('That member is already linked to another holder', 'member_taken');
  }
  await db.query('update public.offchain_holders set user_id = $2, linked_by = $3, linked_at = now() where id = $1', [h.id, member.user_id, args.staffUserId]);
  const details = { holderName: h.name, memberCode: args.memberCode.trim().toUpperCase(), toSelf: member.user_id === args.staffUserId };
  await recordAudit(db, args.actor, 'offchain.holder_linked', { type: 'offchain_holder', id: h.id }, details);
  await raiseRiskEvent(db, { userId: member.user_id, kind: 'admin_offchain_link', severity: 'high', subjectType: 'offchain_holder', subjectId: h.id, details });
  await notify(db, { userId: member.user_id, kind: 'offchain_linked', payload: { holderId: h.id }, dedupeKey: `offchain_linked:${h.id}` });
}

/**
 * Open the off-platform record for an existing member, from their user page:
 * a holder named after them, linked to the account in the same transaction.
 */
export async function startHolderForUser(db: Db, args: { userId: string; staffUserId: string; actor: Actor }): Promise<{ id: string }> {
  const p = await maybeOne<{ member_code: string; name: string }>(
    db,
    'select member_code, coalesce(nullif(btrim(display_name), \'\'), username, email) as name from public.user_profiles where user_id = $1',
    [args.userId],
  );
  if (!p) throw new OffchainError('No member has that id', 'member_not_found');
  const existing = await maybeOne<{ id: string }>(db, 'select id from public.offchain_holders where user_id = $1', [args.userId]);
  if (existing) return existing;
  const name = p.name.length >= 2 ? p.name.slice(0, 80) : p.member_code;
  const holder = await createHolder(db, { name, staffUserId: args.staffUserId, actor: args.actor });
  await linkHolder(db, { holderId: holder.id, memberCode: p.member_code, staffUserId: args.staffUserId, actor: args.actor });
  return holder;
}

interface InsertArgs {
  holder: Holder;
  kind: EntryKind;
  amount: bigint;
  occurredOn: string;
  reason: string;
  allocationId?: string | null;
  reversesEntryId?: string | null;
  category?: EntryCategory | null;
  idempotencyKey: string;
  staffUserId: string;
  actor: Actor;
}

/** Insert one entry, or return the one already recorded under this idempotency key (a retry). */
async function insertEntry(db: Db, a: InsertArgs): Promise<{ id: string; replayed: boolean }> {
  const existing = await maybeOne<{ id: string; holder_id: string; kind: string; amount_micro: string }>(
    db,
    'select id, holder_id, kind, amount_micro::text from public.offchain_entries where idempotency_key = $1',
    [a.idempotencyKey],
  );
  if (existing) {
    if (existing.holder_id !== a.holder.id || existing.kind !== a.kind || parseBase(existing.amount_micro) !== a.amount) {
      throw new OffchainError('This request key was already used for a different entry', 'idempotency_conflict');
    }
    return { id: existing.id, replayed: true };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.occurredOn)) throw new OffchainError('Use a date like 2026-10-27', 'invalid_date');
  let row: { id: string };
  try {
    row = await one<{ id: string }>(
      db,
      `insert into public.offchain_entries (holder_id, kind, amount_micro, occurred_on, reason, allocation_id, reverses_entry_id, idempotency_key, created_by${a.category ? ', category' : ''})
       values ($1, $2, $3, $4::date, $5, $6, $7, $8, $9${a.category ? ', $10' : ''}) returning id`,
      [a.holder.id, a.kind, a.amount.toString(), a.occurredOn, a.reason, a.allocationId ?? null, a.reversesEntryId ?? null, a.idempotencyKey, a.staffUserId, ...(a.category ? [a.category] : [])],
    );
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'P0002') throw new OffchainError('That would make the off-platform balance negative', 'insufficient_balance');
    if (code === '23505') throw new OffchainError('That entry or receipt was already recorded', 'duplicate');
    if (code === 'P0005') throw new OffchainError((err as Error).message, 'invalid_entry');
    throw err;
  }
  const details = {
    holderName: a.holder.name,
    kind: a.kind,
    category: a.category ?? null,
    amountUsdt: formatUnits(a.amount, MICRO_DECIMALS),
    occurredOn: a.occurredOn,
    reason: a.reason,
    allocationId: a.allocationId ?? null,
    reversesEntryId: a.reversesEntryId ?? null,
    toSelf: a.holder.user_id === a.staffUserId,
  };
  await recordAudit(db, a.actor, `offchain.entry_${a.kind}`, { type: 'offchain_entry', id: row.id }, details);
  await raiseRiskEvent(db, {
    userId: a.holder.user_id,
    kind: details.toSelf ? 'admin_self_offchain_entry' : 'admin_offchain_entry',
    severity: 'high',
    subjectType: 'offchain_entry',
    subjectId: row.id,
    details,
  });
  if (a.holder.user_id) {
    await notify(db, { userId: a.holder.user_id, kind: 'offchain_entry', payload: { entryId: row.id, kind: a.kind, amountMicro: a.amount.toString(), reason: a.reason }, dedupeKey: `offchain_entry:${row.id}` });
  }
  return { id: row.id, replayed: false };
}

export async function recordEntry(
  db: Db,
  args: {
    holderId: string;
    kind: ManualKind;
    category?: EntryCategory | null;
    amount: string;
    occurredOn: string;
    reason: string;
    idempotencyKey: string;
    staffUserId: string;
    actor: Actor;
  },
): Promise<{ id: string }> {
  if (args.category && args.kind !== 'earnings') throw new OffchainError('Only earnings can be a matching bonus', 'invalid_category');
  const reason = requireReason(args.reason);
  const amount = signedMicro(args.kind, args.amount);
  const holder = await lockHolder(db, args.holderId);
  return insertEntry(db, { ...args, holder, amount, reason });
}

/**
 * Set the balance to a new total by recording the difference as one
 * 'adjustment' entry (history stays append-only). `expected` is the balance the
 * administrator was looking at: if it changed meanwhile, nothing is recorded,
 * so two edits never stack by surprise. A retry with the same key returns the
 * entry already recorded. Without a reason, one describing the change is used.
 */
export async function setBalance(
  db: Db,
  args: { holderId: string; target: string; expected: string; occurredOn: string; reason?: string | null; idempotencyKey: string; staffUserId: string; actor: Actor },
): Promise<{ id: string }> {
  const holder = await lockHolder(db, args.holderId);
  const replay = await maybeOne<{ id: string; holder_id: string }>(db, 'select id, holder_id from public.offchain_entries where idempotency_key = $1', [args.idempotencyKey]);
  if (replay) {
    if (replay.holder_id !== holder.id) throw new OffchainError('This request key was already used for a different entry', 'idempotency_conflict');
    return { id: replay.id };
  }
  let target: bigint;
  let expected: bigint;
  try {
    target = parseUnits(args.target, MICRO_DECIMALS);
    expected = parseUnits(args.expected, MICRO_DECIMALS);
  } catch {
    throw new OffchainError('Enter an amount like 125.50 (at most 6 decimals)', 'invalid_amount');
  }
  if (target < 0n) throw new OffchainError('A balance cannot be negative', 'insufficient_balance');
  const current = await offchainBalance(db, holder.id);
  if (current !== expected) throw new OffchainError('The balance changed while you were editing. Reload and try again.', 'balance_changed');
  if (target === current) throw new OffchainError('That is already the balance', 'no_change');
  // The reason is optional here: without one, the entry says what changed.
  const typed = args.reason?.trim() ?? '';
  const reason = typed
    ? requireReason(typed.length >= MIN_REASON ? typed : `Balance edit: ${typed}`)
    : `Balance changed from ${formatUnits(current, MICRO_DECIMALS)} to ${formatUnits(target, MICRO_DECIMALS)} USDT`;
  return insertEntry(db, { ...args, holder, kind: 'adjustment', amount: target - current, reason });
}

/** Correct a mistake: a reversal exactly negates one entry, once. */
export async function reverseEntry(
  db: Db,
  args: { entryId: string; reason: string; idempotencyKey: string; staffUserId: string; actor: Actor },
): Promise<{ id: string }> {
  const reason = requireReason(args.reason);
  const target = await maybeOne<{ holder_id: string; kind: string; amount_micro: string }>(
    db,
    'select holder_id, kind, amount_micro::text from public.offchain_entries where id = $1',
    [args.entryId],
  );
  if (!target) throw new OffchainError('Entry not found', 'not_found');
  if (target.kind === 'reversal') throw new OffchainError('A reversal cannot be reversed; record a new entry instead', 'invalid_entry');
  if (target.kind === 'moved_to_platform') throw new OffchainError('Money moved to the platform is corrected with a deposit correction', 'invalid_entry');
  const holder = await lockHolder(db, target.holder_id);
  return insertEntry(db, {
    holder,
    kind: 'reversal',
    amount: -parseBase(target.amount_micro),
    occurredOn: new Date().toISOString().slice(0, 10),
    reason,
    reversesEntryId: args.entryId,
    idempotencyKey: args.idempotencyKey,
    staffUserId: args.staffUserId,
    actor: args.actor,
  });
}

/**
 * Record that part of the off-platform balance is now on the platform: the
 * administrator sent it to the group wallet and assigned that receipt to the
 * linked member. The entry is bound to the posted assignment and takes its exact amount.
 */
export async function recordMoveToPlatform(
  db: Db,
  args: { holderId: string; allocationId: string; reason: string; idempotencyKey: string; staffUserId: string; actor: Actor },
): Promise<{ id: string }> {
  const reason = requireReason(args.reason);
  const holder = await lockHolder(db, args.holderId);
  if (!holder.user_id) throw new OffchainError('Link this holder to their account first', 'not_linked');
  const a = await maybeOne<{ kind: string; status: string; user_id: string; amount_base: string; decimals: number; posted_at: Date }>(
    db,
    `select a.kind, a.status, l.user_id, l.amount_base::text, t.decimals, a.posted_at
       from public.allocations a
       join public.allocation_lines l on l.allocation_id = a.id
       join public.deposits d on d.id = a.deposit_id
       join public.supported_tokens t on t.id = d.token_id
      where a.id = $1`,
    [args.allocationId],
  );
  if (!a || a.kind !== 'assignment' || a.status !== 'posted') throw new OffchainError('Choose a posted assignment of a group-wallet receipt', 'invalid_allocation');
  if (a.user_id !== holder.user_id) throw new OffchainError('That receipt was assigned to a different member', 'invalid_allocation');
  const micro = baseToMicro(parseBase(a.amount_base), Number(a.decimals));
  return insertEntry(db, {
    holder,
    kind: 'moved_to_platform',
    amount: -micro,
    occurredOn: new Date(a.posted_at).toISOString().slice(0, 10),
    reason,
    allocationId: args.allocationId,
    idempotencyKey: args.idempotencyKey,
    staffUserId: args.staffUserId,
    actor: args.actor,
  });
}

// -----------------------------------------------------------------------------
// Read models
// -----------------------------------------------------------------------------
export interface OffchainEntryView {
  id: string;
  kind: EntryKind;
  amountMicro: bigint;
  occurredOn: string;
  reason: string;
  createdAt: Date;
  reversed: boolean;
  reversesEntryId: string | null;
  allocationId: string | null;
  category: EntryCategory | null;
}

export async function listEntries(db: Db, holderId: string): Promise<OffchainEntryView[]> {
  const rows = await many<{
    id: string;
    kind: EntryKind;
    amount_micro: string;
    occurred_on: string;
    reason: string;
    created_at: Date;
    reversed: boolean;
    reverses_entry_id: string | null;
    allocation_id: string | null;
    category: EntryCategory | null;
  }>(
    db,
    `select e.id::text, e.kind, e.amount_micro::text, to_char(e.occurred_on, 'YYYY-MM-DD') as occurred_on, e.reason, e.created_at,
            exists (select 1 from public.offchain_entries r where r.reverses_entry_id = e.id) as reversed,
            e.reverses_entry_id::text, e.allocation_id,
            -- Read through jsonb so this works before the category migration is applied.
            to_jsonb(e) ->> 'category' as category
       from public.offchain_entries e where e.holder_id = $1 order by e.id desc`,
    [holderId],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    amountMicro: parseBase(r.amount_micro),
    occurredOn: r.occurred_on,
    reason: r.reason,
    createdAt: r.created_at,
    reversed: r.reversed,
    reversesEntryId: r.reverses_entry_id,
    allocationId: r.allocation_id,
    category: r.category,
  }));
}

export async function listHolders(db: Db) {
  return many<{ id: string; name: string; note: string | null; user_id: string | null; member_code: string | null; balance: string; entries: number; last_entry: Date | null }>(
    db,
    `select h.id, h.name, h.note, h.user_id, p.member_code,
            coalesce(sum(e.amount_micro), 0)::text as balance, count(e.id)::int as entries, max(e.created_at) as last_entry
       from public.offchain_holders h
       left join public.user_profiles p on p.user_id = h.user_id
       left join public.offchain_entries e on e.holder_id = h.id
      group by h.id, p.member_code order by h.name`,
  );
}

export async function getHolder(db: Db, holderId: string) {
  return maybeOne<{ id: string; name: string; note: string | null; user_id: string | null; member_code: string | null; created_at: Date; linked_at: Date | null }>(
    db,
    `select h.id, h.name, h.note, h.user_id, p.member_code, h.created_at, h.linked_at
       from public.offchain_holders h left join public.user_profiles p on p.user_id = h.user_id where h.id = $1`,
    [holderId],
  );
}

/** The off-platform record linked to this account, if any. */
export async function holderOfUser(db: Db, userId: string) {
  return maybeOne<{ id: string; name: string; note: string | null; user_id: string | null }>(
    db,
    'select id, name, note, user_id from public.offchain_holders where user_id = $1',
    [userId],
  );
}

/** Records not yet linked to any account (people recorded by name before they had a login). */
export async function unlinkedHolders(db: Db) {
  return (await listHolders(db)).filter((h) => !h.user_id);
}

/** Posted assignments to the linked member not yet matched to a 'moved_to_platform' entry. */
export async function unmatchedAssignments(db: Db, userId: string) {
  return many<{ id: string; amount_base: string; decimals: number; symbol: string; posted_at: Date; reason: string }>(
    db,
    `select a.id, l.amount_base::text, t.decimals, t.symbol, a.posted_at, a.reason
       from public.allocations a
       join public.allocation_lines l on l.allocation_id = a.id
       join public.deposits d on d.id = a.deposit_id
       join public.supported_tokens t on t.id = d.token_id
      where a.kind = 'assignment' and a.status = 'posted' and l.user_id = $1
        and not exists (select 1 from public.offchain_entries e where e.allocation_id = a.id)
      order by a.posted_at desc limit 50`,
    [userId],
  );
}

/** The signed-in member's off-platform record, if an administrator linked one. */
export async function memberHolding(db: Db, userId: string) {
  const h = await maybeOne<{ id: string; name: string }>(db, 'select id, name from public.offchain_holders where user_id = $1', [userId]);
  if (!h) return null;
  const [balance, entries] = await Promise.all([offchainBalance(db, h.id), listEntries(db, h.id)]);
  return { ...h, balance, entries };
}
