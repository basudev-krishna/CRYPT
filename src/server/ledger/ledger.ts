/**
 * TypeScript facade over the SQL ledger (schema `ledger`).
 * All functions take a Db so they compose inside a caller's transaction.
 */
import { many, maybeOne, one, type Db } from '../db-core';
import { parseBase } from '@/lib/money';

export type AccountPurpose =
  | 'treasury_hot'
  | 'treasury_cold'
  | 'pool_assets'
  | 'user_cash'
  | 'user_reserved'
  | 'user_pending_subscription'
  | 'pool_investor_equity'
  | 'pool_fees_payable'
  | 'suspense_deposits'
  | 'fee_revenue'
  | 'network_fee_expense'
  | 'owner_equity'
  | 'referral_reward_fund'
  | 'operator_float';

export type Direction = 'D' | 'C';

export interface LedgerLine {
  accountId: string;
  direction: Direction;
  amount: bigint;
  memo?: string;
}

export interface PostEntryInput {
  idempotencyKey: string;
  eventType: string;
  sourceType: string;
  sourceId: string;
  description: string;
  postedBy: string;
  lines: LedgerLine[];
  metadata?: Record<string, unknown>;
}

export class LedgerError extends Error {
  override name = 'LedgerError';
}

export async function ensureAccount(
  db: Db,
  purpose: AccountPurpose,
  tokenId: number,
  scope: { userId?: string; poolId?: number } = {},
): Promise<string> {
  const row = await one<{ id: string }>(
    db,
    'select ledger.ensure_account($1::public.account_purpose, $2::smallint, $3::uuid, $4::smallint) as id',
    [purpose, tokenId, scope.userId ?? null, scope.poolId ?? null],
  );
  return row.id;
}

/** Client-side validation mirrors the database rules so errors surface early and clearly. */
export function validateLines(lines: LedgerLine[]): void {
  if (lines.length < 2) throw new LedgerError('An entry needs at least two lines');
  let net = 0n;
  for (const l of lines) {
    if (l.amount <= 0n) throw new LedgerError('Line amounts must be positive');
    net += l.direction === 'D' ? l.amount : -l.amount;
  }
  // Per-token balance is enforced in SQL (accounts carry the token); a single
  // entry in this codebase never mixes tokens except gas postings, which are
  // posted as separate entries.
  if (net !== 0n) throw new LedgerError('Entry is unbalanced');
}

/** Post a balanced, immutable journal entry. Idempotent on idempotencyKey. Returns entry id. */
export async function postEntry(db: Db, input: PostEntryInput): Promise<string> {
  validateLines(input.lines);
  const lines = input.lines.map((l) => ({
    account_id: Number(l.accountId),
    direction: l.direction,
    amount: l.amount.toString(),
    ...(l.memo ? { memo: l.memo } : {}),
  }));
  const row = await one<{ id: string }>(
    db,
    `select ledger.post_entry($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, null) as id`,
    [
      input.idempotencyKey,
      input.eventType,
      input.sourceType,
      input.sourceId,
      input.description,
      input.postedBy,
      JSON.stringify(lines),
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  return row.id;
}

/** Simple two-line transfer helper. */
export function transfer(debitAccountId: string, creditAccountId: string, amount: bigint, memo?: string): LedgerLine[] {
  return [
    { accountId: debitAccountId, direction: 'D', amount, memo },
    { accountId: creditAccountId, direction: 'C', amount, memo },
  ];
}

/**
 * Lock an account's balance row for the rest of the transaction and return it.
 * This serializes concurrent spends from the same account.
 */
export async function lockBalance(db: Db, accountId: string): Promise<bigint> {
  const row = await one<{ balance: string }>(db, 'select ledger.lock_balance($1)::text as balance', [accountId]);
  return parseBase(row.balance);
}

export async function cachedBalance(db: Db, accountId: string): Promise<bigint> {
  const row = await maybeOne<{ balance: string }>(db, 'select balance from public.account_balances where account_id = $1', [accountId]);
  return parseBase(row?.balance);
}

export async function journalBalance(db: Db, accountId: string): Promise<bigint> {
  const row = await one<{ b: string }>(db, 'select ledger.journal_balance($1)::text as b', [accountId]);
  return parseBase(row.b);
}

export async function balanceByPurpose(db: Db, purpose: AccountPurpose, tokenId: number): Promise<bigint> {
  const row = await one<{ b: string | null }>(
    db,
    `select coalesce(sum(b.balance), 0)::text as b
       from public.ledger_accounts a join public.account_balances b on b.account_id = a.id
      where a.purpose = $1 and a.token_id = $2`,
    [purpose, tokenId],
  );
  return parseBase(row.b);
}

export interface UserTokenBalance {
  tokenId: number;
  cash: bigint;
  reserved: bigint;
  pendingSubscription: bigint;
}

export async function userBalances(db: Db, userId: string): Promise<UserTokenBalance[]> {
  const rows = await many<{ token_id: number; cash_base: string; reserved_base: string; pending_subscription_base: string }>(
    db,
    'select token_id, cash_base::text, reserved_base::text, pending_subscription_base::text from public.user_ledger_balances where user_id = $1',
    [userId],
  );
  return rows.map((r) => ({
    tokenId: Number(r.token_id),
    cash: parseBase(r.cash_base),
    reserved: parseBase(r.reserved_base),
    pendingSubscription: parseBase(r.pending_subscription_base),
  }));
}

export interface IntegrityReport {
  unbalancedTokens: { tokenId: number; debits: bigint; credits: bigint }[];
  cacheMismatches: { accountId: string; cached: bigint; journal: bigint }[];
}

/** Verify the journal nets to zero per token and the balance cache matches the journal. */
export async function checkIntegrity(db: Db): Promise<IntegrityReport> {
  const tb = await many<{ token_id: number; total_debits: string; total_credits: string }>(
    db,
    'select token_id, total_debits::text, total_credits::text from public.ledger_trial_balance',
  );
  const mismatches = await many<{ account_id: string; cached: string; journal: string }>(
    db,
    `select b.account_id, b.balance::text as cached, ledger.journal_balance(b.account_id)::text as journal
       from public.account_balances b
      where b.balance <> ledger.journal_balance(b.account_id)`,
  );
  return {
    unbalancedTokens: tb
      .filter((r) => r.total_debits !== r.total_credits)
      .map((r) => ({ tokenId: Number(r.token_id), debits: parseBase(r.total_debits), credits: parseBase(r.total_credits) })),
    cacheMismatches: mismatches.map((m) => ({ accountId: m.account_id, cached: parseBase(m.cached), journal: parseBase(m.journal) })),
  };
}
