/**
 * Inline jobs (JOBS_MODE=inline): without a worker, admin actions post at once
 * and "Sync & process now" runs one pass of the worker's schedule.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { admin, balanceOf, closePools, createUser, resetAppData, simAdapter, simDeposit, simToken, usdt, web, worker } from '../helpers/db';
import { one, withTransaction } from '../../src/server/db-core';
import { checkIntegrity } from '../../src/server/ledger/ledger';
import { SimulatedChainAdapter } from '../../src/server/chains/simulated';
import { creditDeposit, ingestNetwork, refreshDeposit } from '../../src/server/deposits/service';
import { createAllocation } from '../../src/server/deposits/allocations';
import { activatePlan, createPlan } from '../../src/server/returns/service';
import { runAllInline, runJobInline } from '../../src/server/jobs/inline';

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

async function unattributedReceipt(amount: string): Promise<string> {
  await simDeposit(GROUP, usdt(amount), 5, { from: '0x5555555555555555555555555555555555555555' });
  await admin.query('delete from public.network_scan_state');
  const adapter = await simAdapter();
  await ingestNetwork(worker, adapter);
  const d = await one<{ id: string }>(admin, "select id from public.deposits where user_id is null and status in ('detected', 'confirming', 'confirmed')");
  await withTransaction(worker, (db) => refreshDeposit(db, new SimulatedChainAdapter(adapter.network, db), d.id));
  await withTransaction(worker, (db) => creditDeposit(db, d.id));
  return d.id;
}

describe('inline jobs', () => {
  it('posts an admin allocation immediately, without a worker', async () => {
    const member = await createUser();
    const depositId = await unattributedReceipt('100');
    const a = await withTransaction(web, (db) => createAllocation(db, { depositId, kind: 'assignment', reason: 'Member deposit recorded', lines: [{ userId: member, amount: '100' }], staffUserId: adminId, actor: actor() }));
    const r = await runJobInline('allocation.post', { allocationId: a.id });
    expect(r.failed).toEqual([]);
    expect(await balanceOf('user_cash', tokenId, member)).toBe(usdt('100'));
  });

  it('one sync enrols deposits into the automatic plan and keeps the books balanced', async () => {
    const member = await createUser();
    const depositId = await unattributedReceipt('1000');
    await withTransaction(web, (db) => createAllocation(db, { depositId, kind: 'assignment', reason: 'Member deposit recorded', lines: [{ userId: member, amount: '1000' }], staffUserId: adminId, actor: actor() }));
    const { id: planId } = await withTransaction(web, (db) =>
      createPlan(db, { name: 'Auto 0.33', tokenId, dailyRatePpm: 3300, minPrincipal: '10', termDays: null, payableAfterDays: 0, principalLockDays: 0, termsReference: 'Terms v1', autoEnroll: true, staffUserId: adminId, actor: actor() }),
    );
    await withTransaction(web, (db) => activatePlan(db, { planId, note: 'Approved by the board', staffUserId: adminId, actor: actor() }));

    const summary = await runAllInline();
    expect(summary.jobs).toBeGreaterThan(0);
    // The pending allocation was posted and the deposit enrolled, all in one pass.
    expect(await balanceOf('plan_principal', tokenId, member)).toBe(usdt('1000'));
    expect(await balanceOf('user_cash', tokenId, member)).toBe(0n);
    expect(await checkIntegrity(admin)).toEqual({ unbalancedTokens: [], cacheMismatches: [] });

    // A second pass changes nothing.
    await runAllInline();
    expect(await balanceOf('plan_principal', tokenId, member)).toBe(usdt('1000'));
  });
});
