/**
 * Off-platform holdings: an append-only memo ledger of money handed to the
 * administrator personally, kept out of the platform ledger.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { admin, balanceOf, closePools, createUser, resetAppData, simAdapter, simDeposit, simToken, usdt, web, worker } from '../helpers/db';
import { one, withTransaction } from '../../src/server/db-core';
import { checkIntegrity } from '../../src/server/ledger/ledger';
import { adminManualAdditions } from '../../src/server/queries/admin';
import { SimulatedChainAdapter } from '../../src/server/chains/simulated';
import { creditDeposit, ingestNetwork, refreshDeposit } from '../../src/server/deposits/service';
import { createAllocation, postAllocation } from '../../src/server/deposits/allocations';
import { createHolder, holderOfUser, listEntries, setBalance, linkHolder, memberHolding, startHolderForUser, offchainBalance, recordEntry, recordMoveToPlatform, reverseEntry, type ManualKind } from '../../src/server/offchain/holdings';

const GROUP = '0x0000000000000000000000000000000000000a07';
let adminId: string;
let tokenId: number;

beforeEach(async () => {
  await resetAppData();
  await admin.query('update public.treasury_wallets set receives_deposits = true where address = $1', [GROUP]);
  tokenId = (await simToken()).id;
  adminId = await createUser();
  await admin.query("insert into public.staff_roles (user_id, role) values ($1, 'admin')", [adminId]);
});
afterAll(closePools);

const actor = () => ({ type: 'staff' as const, id: adminId });
const micro = (v: string) => usdt(v); // sim USDT and micro-USDT both have 6 decimals
const holder = (name = 'Friend One') => withTransaction(web, (db) => createHolder(db, { name, staffUserId: adminId, actor: actor() }));
const entry = (holderId: string, kind: ManualKind, amount: string, key = randomUUID()) =>
  withTransaction(web, (db) => recordEntry(db, { holderId, kind, amount, occurredOn: '2026-10-20', reason: 'Handed over in person', idempotencyKey: key, staffUserId: adminId, actor: actor() }));
const balance = (holderId: string) => offchainBalance(admin, holderId);
const memberCode = async (userId: string) => (await one<{ member_code: string }>(admin, 'select member_code from public.user_profiles where user_id = $1', [userId])).member_code;

/** Admin sends the friend's money into the group wallet and assigns the receipt to them. */
async function assignOnPlatform(userId: string, amount: string): Promise<string> {
  await simDeposit(GROUP, usdt(amount), 5, { from: '0x4444444444444444444444444444444444444444' });
  await admin.query('delete from public.network_scan_state');
  const adapter = await simAdapter();
  await ingestNetwork(worker, adapter);
  const d = await one<{ id: string }>(admin, "select id from public.deposits where user_id is null and status in ('detected', 'confirming', 'confirmed') limit 1");
  await withTransaction(worker, (db) => refreshDeposit(db, new SimulatedChainAdapter(adapter.network, db), d.id));
  await withTransaction(worker, (db) => creditDeposit(db, d.id));
  const a = await withTransaction(web, (db) =>
    createAllocation(db, { depositId: d.id, kind: 'assignment', reason: 'Moved from personal holding', lines: [{ userId, amount }], staffUserId: adminId, actor: actor() }),
  );
  await withTransaction(worker, (db) => postAllocation(db, a.id, { type: 'service', id: 'test' }));
  return a.id;
}

describe('off-platform ledger', () => {
  it('records received money, earnings and paybacks without touching the platform ledger', async () => {
    const h = await holder();
    await entry(h.id, 'contribution', '500');
    await entry(h.id, 'earnings', '25.5');
    await entry(h.id, 'payback', '100');
    expect(await balance(h.id)).toBe(micro('425.5'));
    expect((await admin.query('select count(*)::int as n from public.journal_entries')).rows[0].n).toBe(0);
    // Each entry is audited and alerted.
    expect((await admin.query("select count(*)::int as n from public.risk_events where kind = 'admin_offchain_entry' and severity = 'high'")).rows[0].n).toBe(3);
    expect((await admin.query("select count(*)::int as n from public.audit_events where action like 'offchain.entry_%'")).rows[0].n).toBe(3);
  });

  it('never lets a balance go negative and records a retried request once', async () => {
    const h = await holder();
    await entry(h.id, 'contribution', '50');
    await expect(entry(h.id, 'payback', '60')).rejects.toMatchObject({ code: 'insufficient_balance' });
    await expect(entry(h.id, 'adjustment', '-60')).rejects.toMatchObject({ code: 'insufficient_balance' });
    const key = randomUUID();
    const first = await entry(h.id, 'earnings', '5', key);
    const again = await entry(h.id, 'earnings', '5', key);
    expect(again.id).toBe(first.id);
    await expect(entry(h.id, 'earnings', '7', key)).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(await balance(h.id)).toBe(micro('55'));
  });

  it('corrects mistakes by reversal only, once per entry', async () => {
    const h = await holder();
    const wrong = await entry(h.id, 'contribution', '1000');
    await entry(h.id, 'contribution', '100');
    const rev = (entryId: string) =>
      withTransaction(web, (db) => reverseEntry(db, { entryId, reason: 'Typed 1000 instead of 100', idempotencyKey: `reverse:${entryId}`, staffUserId: adminId, actor: actor() }));
    const r = await rev(wrong.id);
    expect(await balance(h.id)).toBe(micro('100'));
    expect((await rev(wrong.id)).id).toBe(r.id); // retry: same reversal
    await expect(rev(r.id)).rejects.toMatchObject({ code: 'invalid_entry' });
    // Entries are immutable, for the web role and even the table owner.
    await expect(web.query('update public.offchain_entries set amount_micro = 1 where id = $1', [wrong.id])).rejects.toThrow();
    await expect(web.query('delete from public.offchain_entries where id = $1', [wrong.id])).rejects.toThrow();
    await expect(admin.query('update public.offchain_entries set amount_micro = 1 where id = $1', [wrong.id])).rejects.toThrow();
    // A reversal that doesn't negate its target is refused by the database itself.
    await expect(
      admin.query(
        "insert into public.offchain_entries (holder_id, kind, amount_micro, occurred_on, reason, reverses_entry_id, idempotency_key, created_by) values ($1, 'reversal', -5, current_date, 'Bad reversal attempt', $2, 'k-bad', $3)",
        [h.id, (await entry(h.id, 'contribution', '10')).id, adminId],
      ),
    ).rejects.toThrow(/exactly negate/);
  });

  it('links to an account once, shows the member their record, and moves money on the platform exactly', async () => {
    const friend = await createUser();
    const h = await holder();
    await entry(h.id, 'contribution', '300');
    const link = (memberCode: string, holderId = h.id) => withTransaction(web, (db) => linkHolder(db, { holderId, memberCode, staffUserId: adminId, actor: actor() }));
    await link(await memberCode(friend));
    await expect(link(await memberCode(adminId))).rejects.toMatchObject({ code: 'already_linked' });
    const other = await holder('Someone Else');
    await expect(link(await memberCode(friend), other.id)).rejects.toMatchObject({ code: 'member_taken' });

    const seen = await memberHolding(web, friend);
    expect(seen).toMatchObject({ balance: micro('300') });
    expect(seen!.entries).toHaveLength(1);
    expect(await memberHolding(web, adminId)).toBeNull();

    // Off-platform money is not withdrawable: the member's platform cash is still zero.
    expect(await balanceOf('user_cash', tokenId, friend)).toBe(0n);

    const allocationId = await assignOnPlatform(friend, '120');
    const move = () =>
      withTransaction(web, (db) => recordMoveToPlatform(db, { holderId: h.id, allocationId, reason: 'Sent to the group wallet', idempotencyKey: `move:${allocationId}`, staffUserId: adminId, actor: actor() }));
    await move();
    await move(); // retry records nothing new
    expect(await balance(h.id)).toBe(micro('180'));
    expect(await balanceOf('user_cash', tokenId, friend)).toBe(usdt('120'));
    expect(await checkIntegrity(admin)).toEqual({ unbalancedTokens: [], cacheMismatches: [] });

    // An assignment to someone else can't be matched to this holder.
    const stranger = await createUser();
    const foreign = await assignOnPlatform(stranger, '10');
    await expect(
      withTransaction(web, (db) => recordMoveToPlatform(db, { holderId: h.id, allocationId: foreign, reason: 'Wrong person entirely', idempotencyKey: `move:${foreign}`, staffUserId: adminId, actor: actor() })),
    ).rejects.toMatchObject({ code: 'invalid_allocation' });
  });

  it('opens a linked record from the user page once, even when repeated', async () => {
    const friend = await createUser();
    const start = () => withTransaction(web, (db) => startHolderForUser(db, { userId: friend, staffUserId: adminId, actor: actor() }));
    const first = await start();
    expect(await start()).toEqual(first);
    expect(await holderOfUser(admin, friend)).toMatchObject({ id: first.id, user_id: friend });
    expect((await admin.query('select count(*)::int as n from public.offchain_holders')).rows[0].n).toBe(1);
    await entry(first.id, 'earnings', '40');
    expect(await memberHolding(web, friend)).toMatchObject({ balance: micro('40') });
  });

  it('sets a new total by recording the difference once, and refuses a stale edit', async () => {
    const h = await holder();
    await entry(h.id, 'contribution', '100');
    const set = (target: string, expected: string, key = randomUUID()) =>
      withTransaction(web, (db) => setBalance(db, { holderId: h.id, target, expected, occurredOn: '2026-10-29', reason: 'Balance agreed in person', idempotencyKey: key, staffUserId: adminId, actor: actor() }));
    const key = randomUUID();
    const first = await set('250.5', '100', key);
    expect((await set('250.5', '100', key)).id).toBe(first.id); // a retry records nothing new
    expect(await balance(h.id)).toBe(micro('250.5'));
    await expect(set('300', '100')).rejects.toMatchObject({ code: 'balance_changed' });
    await expect(set('250.5', '250.5')).rejects.toMatchObject({ code: 'no_change' });
    await set('40', '250.5');
    expect(await balance(h.id)).toBe(micro('40'));
    expect((await admin.query("select count(*)::int as n from public.offchain_entries where kind = 'adjustment'")).rows[0].n).toBe(2);
  });

  it('lists hand-made entries for linked members on the admin deposits page, signed', async () => {
    const friend = await createUser();
    const h = await withTransaction(web, (db) => startHolderForUser(db, { userId: friend, staffUserId: adminId, actor: actor() }));
    await entry(h.id, 'earnings', '30');
    await entry(h.id, 'payback', '10');
    const rows = await adminManualAdditions(web);
    expect(rows.map((r) => [r.user_id, r.kind, r.amount])).toEqual([
      [friend, 'payback', '-10000000'],
      [friend, 'earnings', '30000000'],
    ]);
  });

  it('tags a matching bonus so the member and the admin list see it as one', async () => {
    const friend = await createUser();
    const h = await withTransaction(web, (db) => startHolderForUser(db, { userId: friend, staffUserId: adminId, actor: actor() }));
    const add = (kind: ManualKind) =>
      withTransaction(web, (db) =>
        recordEntry(db, { holderId: h.id, kind, category: 'matching_bonus', amount: '12', occurredOn: '2026-10-29', reason: 'Matching bonus for October', idempotencyKey: randomUUID(), staffUserId: adminId, actor: actor() }),
      );
    await add('earnings');
    await expect(add('contribution')).rejects.toMatchObject({ code: 'invalid_category' });
    expect((await listEntries(web, h.id)).map((e) => e.category)).toEqual(['matching_bonus']);
    expect((await adminManualAdditions(web))[0]).toMatchObject({ kind: 'matching_bonus', amount: '12000000' });
  });

  it('is invisible to other members through the public API role', async () => {
    const friend = await createUser();
    const h = await holder();
    await entry(h.id, 'contribution', '40');
    const c = await admin.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, true)", [friend]);
      await c.query('set local role authenticated');
      expect((await c.query('select * from public.offchain_entries')).rowCount).toBe(0);
      expect((await c.query('select * from public.offchain_holders')).rowCount).toBe(0);
      await c.query('rollback');
    } finally {
      c.release();
    }
  });
});
