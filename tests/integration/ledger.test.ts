import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { admin, closePools, createUser, resetAppData, simToken, web, worker } from '../helpers/db';
import { checkIntegrity, ensureAccount, journalBalance, postEntry, transfer, cachedBalance } from '../../src/server/ledger/ledger';
import { withTransaction } from '../../src/server/db-core';

let tokenId: number;

beforeEach(async () => {
  await resetAppData();
  tokenId = (await simToken()).id;
});
afterAll(closePools);

const base = { eventType: 'test', sourceType: 'test', description: 'test entry', postedBy: 'service:test' };

describe('double-entry ledger', () => {
  it('posts a balanced entry and derives balances in each account normal direction', async () => {
    const user = await createUser();
    const treasury = await ensureAccount(worker, 'treasury_hot', tokenId);
    const cash = await ensureAccount(worker, 'user_cash', tokenId, { userId: user });
    await postEntry(worker, { ...base, idempotencyKey: 'test:first', sourceId: '1', lines: transfer(treasury, cash, 100_000000n) });

    expect(await cachedBalance(worker, treasury)).toBe(100_000000n); // asset: debit-normal
    expect(await cachedBalance(worker, cash)).toBe(100_000000n); // liability: credit-normal
    expect(await journalBalance(worker, cash)).toBe(100_000000n);
    expect(await checkIntegrity(worker)).toEqual({ unbalancedTokens: [], cacheMismatches: [] });
  });

  it('rejects unbalanced entries at the database level', async () => {
    const a = await ensureAccount(worker, 'treasury_hot', tokenId);
    const b = await ensureAccount(worker, 'owner_equity', tokenId);
    const lines = JSON.stringify([
      { account_id: Number(a), direction: 'D', amount: '100' },
      { account_id: Number(b), direction: 'C', amount: '99' },
    ]);
    await expect(
      worker.query("select ledger.post_entry('test:unbalanced', 'test', 'test', 'x', 'd', 'service:test', $1::jsonb)", [lines]),
    ).rejects.toThrow(/unbalanced/);
  });

  it('is idempotent on the idempotency key and rejects reuse with different content', async () => {
    const a = await ensureAccount(worker, 'treasury_hot', tokenId);
    const b = await ensureAccount(worker, 'owner_equity', tokenId);
    const first = await postEntry(worker, { ...base, idempotencyKey: 'test:idem', sourceId: 'x', lines: transfer(a, b, 5n) });
    const again = await postEntry(worker, { ...base, idempotencyKey: 'test:idem', sourceId: 'x', lines: transfer(a, b, 5n) });
    expect(again).toBe(first);
    expect(await cachedBalance(worker, a)).toBe(5n);
    await expect(postEntry(worker, { ...base, idempotencyKey: 'test:idem', sourceId: 'x', lines: transfer(a, b, 6n) })).rejects.toThrow(/reused/);
  });

  it('makes posted entries immutable', async () => {
    const a = await ensureAccount(worker, 'treasury_hot', tokenId);
    const b = await ensureAccount(worker, 'owner_equity', tokenId);
    const id = await postEntry(worker, { ...base, idempotencyKey: 'test:imm', sourceId: 'x', lines: transfer(a, b, 5n) });
    // Even the superuser cannot edit or delete through normal DML.
    await expect(admin.query("update public.journal_entries set description = 'edited' where id = $1", [id])).rejects.toThrow(/not allowed/);
    await expect(admin.query('delete from public.journal_lines where entry_id = $1', [id])).rejects.toThrow(/not allowed/);
    await expect(admin.query('update public.journal_lines set amount = 1 where entry_id = $1', [id])).rejects.toThrow(/not allowed/);
  });

  it('refuses to let a customer balance go negative', async () => {
    const user = await createUser();
    const cash = await ensureAccount(worker, 'user_cash', tokenId, { userId: user });
    const reserved = await ensureAccount(worker, 'user_reserved', tokenId, { userId: user });
    await expect(postEntry(worker, { ...base, idempotencyKey: 'test:neg', sourceId: 'x', lines: transfer(cash, reserved, 1n) })).rejects.toThrow(
      /insufficient balance/,
    );
  });

  it('corrects mistakes only with reversing entries', async () => {
    const a = await ensureAccount(worker, 'treasury_hot', tokenId);
    const b = await ensureAccount(worker, 'owner_equity', tokenId);
    const id = await postEntry(worker, { ...base, idempotencyKey: 'test:rev', sourceId: 'x', lines: transfer(a, b, 42n) });
    await expect(worker.query("select ledger.reverse_entry($1, 'short', 'service:test')", [id])).rejects.toThrow(/documented reason/);
    // Reversing twice is idempotent: the same reversal entry comes back, nothing new is posted.
    const r1 = await worker.query("select ledger.reverse_entry($1, 'posted to the wrong account by test', 'service:test') as id", [id]);
    const r2 = await worker.query("select ledger.reverse_entry($1, 'posted to the wrong account by test', 'service:test') as id", [id]);
    expect(r2.rows[0].id).toBe(r1.rows[0].id);
    expect(await cachedBalance(worker, a)).toBe(0n);
    // A reversal itself cannot be reversed.
    await expect(worker.query("select ledger.reverse_entry($1, 'reversing a reversal is forbidden', 'service:test')", [r1.rows[0].id])).rejects.toThrow(/cannot reverse/);
  });

  it('denies direct ledger writes to backend roles (only ledger functions may write)', async () => {
    const a = await ensureAccount(worker, 'treasury_hot', tokenId);
    for (const pool of [web, worker]) {
      await expect(
        pool.query("insert into public.journal_entries (idempotency_key, event_type, source_type, source_id, description, payload_hash, posted_by) values ('x1234567', 't', 't', 't', 't', 't', 't')"),
      ).rejects.toThrow(/permission denied/);
      await expect(pool.query('update public.account_balances set balance = 1000000 where account_id = $1', [a])).rejects.toThrow(/permission denied/);
    }
    // The web role cannot post reversals.
    await expect(web.query("select ledger.reverse_entry(1, 'attempted by the web role', 'x')")).rejects.toThrow(/permission denied/);
  });

  it('requires every entry to balance per asset, not just in total', async () => {
    const native = await admin.query("select t.id from public.supported_tokens t join public.supported_networks n on n.id = t.network_id where n.code = 'sim-evm' and t.is_native");
    const usdtHot = await ensureAccount(worker, 'treasury_hot', tokenId);
    const gasEquity = await ensureAccount(worker, 'owner_equity', Number(native.rows[0].id));
    // 100 base units of tUSDT against 100 base units of the gas token: nets to zero overall, but not per token.
    await expect(postEntry(worker, { ...base, idempotencyKey: 'test:mixed', sourceId: 'x', lines: transfer(usdtHot, gasEquity, 100n) })).rejects.toThrow(/unbalanced/);
    expect((await admin.query('select count(*)::int as n from public.journal_entries')).rows[0].n).toBe(0);
  });

  it('accepts only positive integer base units (no fractional or float amounts)', async () => {
    const a = await ensureAccount(worker, 'treasury_hot', tokenId);
    const b = await ensureAccount(worker, 'owner_equity', tokenId);
    for (const amount of ['1.5', '0', '-5', '1e3']) {
      const lines = JSON.stringify([
        { account_id: Number(a), direction: 'D', amount },
        { account_id: Number(b), direction: 'C', amount },
      ]);
      await expect(worker.query(`select ledger.post_entry('test:frac:${amount}', 'test', 'test', 'x', 'd', 'service:test', $1::jsonb)`, [lines])).rejects.toThrow();
    }
  });

  it('rolls back every line of an entry when the surrounding transaction fails', async () => {
    const user = await createUser();
    const treasury = await ensureAccount(worker, 'treasury_hot', tokenId);
    const cash = await ensureAccount(worker, 'user_cash', tokenId, { userId: user });
    await expect(
      withTransaction(worker, async (db) => {
        await postEntry(db, { ...base, idempotencyKey: 'test:rollback', sourceId: 'x', lines: transfer(treasury, cash, 500n) });
        throw new Error('business step failed after posting');
      }),
    ).rejects.toThrow(/business step failed/);
    expect(await cachedBalance(worker, cash)).toBe(0n);
    expect(await cachedBalance(worker, treasury)).toBe(0n);
    expect((await admin.query("select count(*)::int as n from public.journal_entries where idempotency_key = 'test:rollback'")).rows[0].n).toBe(0);
    // The key is free again: a retry of the whole business operation posts once.
    await postEntry(worker, { ...base, idempotencyKey: 'test:rollback', sourceId: 'x', lines: transfer(treasury, cash, 500n) });
    expect(await cachedBalance(worker, cash)).toBe(500n);
  });

  it('posts once when the same request is retried concurrently (duplicate jobs / double clicks)', async () => {
    const a = await ensureAccount(worker, 'treasury_hot', tokenId);
    const b = await ensureAccount(worker, 'owner_equity', tokenId);
    const post = () => withTransaction(worker, (db) => postEntry(db, { ...base, idempotencyKey: 'test:dup', sourceId: 'x', lines: transfer(a, b, 7n) }));
    const ids = await Promise.all([post(), post(), post(), post(), post()]);
    expect(new Set(ids).size).toBe(1);
    expect(await cachedBalance(worker, a)).toBe(7n);
  });

  it('does not deadlock on concurrent opposite-direction transfers and keeps totals exact', async () => {
    const u1 = await createUser();
    const u2 = await createUser();
    const treasury = await ensureAccount(worker, 'treasury_hot', tokenId);
    const c1 = await ensureAccount(worker, 'user_cash', tokenId, { userId: u1 });
    const c2 = await ensureAccount(worker, 'user_cash', tokenId, { userId: u2 });
    await postEntry(worker, { ...base, idempotencyKey: 'test:fund:u1', sourceId: 'x', lines: transfer(treasury, c1, 1000n) });
    await postEntry(worker, { ...base, idempotencyKey: 'test:fund:u2', sourceId: 'x', lines: transfer(treasury, c2, 1000n) });
    const move = (i: number, from: string, to: string) =>
      withTransaction(worker, (db) => postEntry(db, { ...base, idempotencyKey: `test:move:${i}`, sourceId: String(i), lines: transfer(from, to, 10n) }), { retries: 10 });
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => (i % 2 ? move(i, c1, c2) : move(i, c2, c1))));
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(0);
    expect((await cachedBalance(worker, c1)) + (await cachedBalance(worker, c2))).toBe(2000n);
    expect(await cachedBalance(worker, c1)).toBe(1000n); // 10 moves each way
    expect(await checkIntegrity(admin)).toEqual({ unbalancedTokens: [], cacheMismatches: [] });
  });

  it('serializes concurrent spends on the same account', async () => {
    const user = await createUser();
    const treasury = await ensureAccount(worker, 'treasury_hot', tokenId);
    const cash = await ensureAccount(worker, 'user_cash', tokenId, { userId: user });
    const reserved = await ensureAccount(worker, 'user_reserved', tokenId, { userId: user });
    await postEntry(worker, { ...base, idempotencyKey: 'test:fund', sourceId: 'x', lines: transfer(treasury, cash, 100n) });

    const spend = (n: number) =>
      withTransaction(worker, (db) => postEntry(db, { ...base, idempotencyKey: `test:spend:${n}`, sourceId: String(n), lines: transfer(cash, reserved, 60n) }));
    const results = await Promise.allSettled([spend(1), spend(2), spend(3)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await cachedBalance(worker, cash)).toBe(40n);
  });
});
