/**
 * Manual balance adjustments against the operator float: admin credits and
 * debits for money settled personally, without ever creating money.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { admin, balanceOf, closePools, createUser, resetAppData, simAdapter, simDeposit, simToken, usdt, web, worker } from '../helpers/db';
import { one, withTransaction } from '../../src/server/db-core';
import { checkIntegrity } from '../../src/server/ledger/ledger';
import { SimulatedChainAdapter } from '../../src/server/chains/simulated';
import { creditDeposit, ingestNetwork, refreshDeposit } from '../../src/server/deposits/service';
import { createAllocation, postAllocation } from '../../src/server/deposits/allocations';
import { cancelAdjustment, createAdjustment, postAdjustment, reverseAdjustment, type Direction } from '../../src/server/adjustments/manual';

const GROUP = '0x0000000000000000000000000000000000000a07';
const service = { type: 'service' as const, id: 'test' };
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
const clean = { unbalancedTokens: [], cacheMismatches: [] };

/** The operator sends their own USDT to the group wallet and allocates it to the float. */
async function topUpFloat(amount: string) {
  await simDeposit(GROUP, usdt(amount), 5, { from: '0x4444444444444444444444444444444444444444' });
  await admin.query('delete from public.network_scan_state');
  const adapter = await simAdapter();
  await ingestNetwork(worker, adapter);
  const d = await one<{ id: string }>(admin, "select id from public.deposits where user_id is null and status in ('detected', 'confirming', 'confirmed') limit 1");
  await withTransaction(worker, (db) => refreshDeposit(db, new SimulatedChainAdapter(adapter.network, db), d.id));
  await withTransaction(worker, (db) => creditDeposit(db, d.id));
  const a = await withTransaction(web, (db) => createAllocation(db, { depositId: d.id, kind: 'operator_float', reason: 'Operator float top-up', lines: [], staffUserId: adminId, actor: actor() }));
  expect(await withTransaction(worker, (db) => postAllocation(db, a.id, service))).toBe('posted');
}

const adjust = (userId: string, direction: Direction, amount: string) =>
  withTransaction(web, (db) => createAdjustment(db, { userId, tokenId, direction, amount, reason: 'Paid me in person yesterday', staffUserId: adminId, actor: actor() }));
const post = (id: string) => withTransaction(worker, (db) => postAdjustment(db, id, service));
const reverse = (adjustmentId: string) => withTransaction(web, (db) => reverseAdjustment(db, { adjustmentId, reason: 'Entered for the wrong person', staffUserId: adminId, actor: actor() }));
const status = async (id: string) => (await one<{ status: string; error: string | null }>(admin, 'select status, error from public.manual_adjustments where id = $1', [id]));

describe('manual balance adjustments', () => {
  it('credits only from the float, exactly once, and keeps the books balanced', async () => {
    const member = await createUser();
    const credit = await adjust(member, 'credit', '30');
    expect(await post(credit.id)).toBe('deferred'); // no float yet: held, not created from nothing
    expect((await status(credit.id)).error).toMatch(/float is too low/);
    expect(await balanceOf('user_cash', tokenId, member)).toBe(0n);

    await topUpFloat('100');
    expect(await post(credit.id)).toBe('posted');
    expect(await post(credit.id)).toBe('unchanged');
    expect(await balanceOf('user_cash', tokenId, member)).toBe(usdt('30'));
    expect(await balanceOf('operator_float', tokenId)).toBe(usdt('70'));
    expect((await admin.query("select count(*)::int as n from public.risk_events where kind = 'admin_adjustment' and severity = 'high'")).rows[0].n).toBe(1);
    expect(await checkIntegrity(admin)).toEqual(clean);
  });

  it('debits back into the float, but never more than the member has', async () => {
    const member = await createUser();
    await topUpFloat('100');
    await post((await adjust(member, 'credit', '30')).id);
    const tooMuch = await adjust(member, 'debit', '50');
    expect(await post(tooMuch.id)).toBe('failed');
    const ok = await adjust(member, 'debit', '10');
    expect(await post(ok.id)).toBe('posted');
    expect(await balanceOf('user_cash', tokenId, member)).toBe(usdt('20'));
    expect(await balanceOf('operator_float', tokenId)).toBe(usdt('80'));
    expect(await checkIntegrity(admin)).toEqual(clean);
  });

  it('fixes mistakes by one reversal, and cancels pending ones', async () => {
    const member = await createUser();
    await topUpFloat('100');
    const wrong = await adjust(member, 'credit', '40');
    await post(wrong.id);
    const r = await reverse(wrong.id);
    await expect(reverse(wrong.id)).rejects.toMatchObject({ code: 'already_reversed' });
    expect(await post(r.id)).toBe('posted');
    await expect(reverse(r.id)).rejects.toMatchObject({ code: 'invalid_state' });
    expect(await balanceOf('user_cash', tokenId, member)).toBe(0n);
    expect(await balanceOf('operator_float', tokenId)).toBe(usdt('100'));

    const pending = await adjust(member, 'credit', '5');
    await withTransaction(web, (db) => cancelAdjustment(db, { adjustmentId: pending.id, reason: 'Duplicate of an earlier one', actor: actor() }));
    expect(await post(pending.id)).toBe('unchanged');
    expect((await status(pending.id)).status).toBe('cancelled');
  });

  it('refuses inactive members and keeps amounts and posting away from the web role', async () => {
    const frozen = await createUser({ status: 'frozen' });
    await expect(adjust(frozen, 'credit', '1')).rejects.toMatchObject({ code: 'member_not_active' });
    const member = await createUser();
    const a = await adjust(member, 'credit', '1');
    await expect(web.query('update public.manual_adjustments set amount_base = 999 where id = $1', [a.id])).rejects.toThrow();
    await expect(web.query("update public.manual_adjustments set status = 'posted' where id = $1", [a.id])).rejects.toThrow();
    await expect(web.query('delete from public.manual_adjustments where id = $1', [a.id])).rejects.toThrow();
  });
});
