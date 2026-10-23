import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { admin, balanceOf, closePools, createUser, mineBlocks, resetAppData, simAdapter, simDeposit, simNetwork, simToken, usdt, web, worker } from '../helpers/db';
import { one, withTransaction, type Db } from '../../src/server/db-core';
import { checkIntegrity, ensureAccount, postEntry, transfer } from '../../src/server/ledger/ledger';
import { insertSimTransfer, SimulatedChainAdapter } from '../../src/server/chains/simulated';
import { getNetwork } from '../../src/server/chains/registry';
import { MockScreeningProvider } from '../../src/server/compliance/compliance';
import { ManualCustodyProvider } from '../../src/server/custody/manual';
import { creditDeposit, ingestNetwork, refreshDeposit } from '../../src/server/deposits/service';
import { cancelAllocation, createAllocation, createCorrection, failCorrection, postAllocation, postCorrection } from '../../src/server/deposits/allocations';
import { confirmWithdrawal, createWithdrawal, monitorWithdrawal, processWithdrawal, type PayoutDeps } from '../../src/server/withdrawals/service';
import { cancelManualPayout, listManualPayoutTasks, recordManualPayout } from '../../src/server/withdrawals/manual-payouts';

const GROUP = '0x0000000000000000000000000000000000000a07';
const DEST = '0x2222222222222222222222222222222222222222';
const service = { type: 'service' as const, id: 'test' };
let tokenId: number;
let contract: string;
let networkId: number;
let adminId: string;

beforeEach(async () => {
  await resetAppData();
  const t = await simToken();
  tokenId = t.id;
  contract = t.contract_address;
  networkId = (await simNetwork()).id;
  await admin.query('update public.treasury_wallets set receives_deposits = true where address = $1', [GROUP]);
  adminId = await createUser();
  await admin.query("insert into public.staff_roles (user_id, role) values ($1, 'admin')", [adminId]);
});
afterAll(closePools);

const staff = () => ({ type: 'staff' as const, id: adminId });

async function tick() {
  const adapter = await simAdapter();
  await ingestNetwork(worker, adapter);
  const ids = (await worker.query("select id from public.deposits where status in ('detected', 'confirming', 'confirmed')")).rows.map((r) => r.id as string);
  for (const id of ids) {
    await withTransaction(worker, (db) => refreshDeposit(db, new SimulatedChainAdapter(adapter.network, db), id));
    await withTransaction(worker, (db) => creditDeposit(db, id));
  }
}

/** An unattributed receipt (e.g. an exchange withdrawal) of `amount`, held in suspense. */
async function unattributed(amount: string) {
  await simDeposit(GROUP, usdt(amount), 5, { from: '0x4444444444444444444444444444444444444444' });
  await tick();
  return one<{ id: string }>(admin, "select id from public.deposits where status = 'under_review' order by detected_at desc limit 1");
}

const allocate = (depositId: string, kind: 'assignment' | 'distribution', lines: { userId: string; amount: string }[], reason = 'Sent from Binance, confirmed by chat') =>
  withTransaction(web, (db) => createAllocation(db, { depositId, kind, reason, lines, staffUserId: adminId, actor: staff() }));
const post = (id: string) => withTransaction(worker, (db) => postAllocation(db, id, service));
const clean = { unbalancedTokens: [], cacheMismatches: [] };

describe('admin allocations', () => {
  it('assigns an unattributed receipt to one member, exactly once', async () => {
    const alice = await createUser();
    const d = await unattributed('300');
    const a = await allocate(d.id, 'assignment', [{ userId: alice, amount: '300' }]);
    expect(await post(a.id)).toBe('posted');
    expect(await post(a.id)).toBe('unchanged');
    expect(await balanceOf('user_cash', tokenId, alice)).toBe(usdt('300'));
    expect(await balanceOf('suspense_deposits', tokenId)).toBe(0n);
    expect(await one(admin, 'select user_id, status from public.deposits where id = $1', [d.id])).toEqual({ user_id: alice, status: 'credited' });
    // Visible to the member and alerted.
    expect((await admin.query("select count(*)::int as n from public.notification_events where user_id = $1 and kind = 'deposit_assigned'", [alice])).rows[0].n).toBe(1);
    expect((await admin.query("select count(*)::int as n from public.risk_events where kind = 'admin_allocation' and severity = 'high'")).rows[0].n).toBe(1);
    expect(await checkIntegrity(admin)).toEqual(clean);
  });

  it('distributes a receipt across members and refuses splits that do not add up', async () => {
    const alice = await createUser();
    const bob = await createUser();
    const d = await unattributed('1000');
    await expect(allocate(d.id, 'distribution', [{ userId: alice, amount: '600' }, { userId: bob, amount: '401' }])).rejects.toMatchObject({ code: 'invalid_split' });
    await expect(allocate(d.id, 'distribution', [{ userId: alice, amount: '600' }, { userId: bob, amount: '399.999999' }])).rejects.toMatchObject({ code: 'invalid_split' });
    const a = await allocate(d.id, 'distribution', [{ userId: alice, amount: '600.5' }, { userId: bob, amount: '399.5' }], 'Profit share for October');
    await post(a.id);
    expect(await balanceOf('user_cash', tokenId, alice)).toBe(usdt('600.5'));
    expect(await balanceOf('user_cash', tokenId, bob)).toBe(usdt('399.5'));
    expect(await balanceOf('treasury_hot', tokenId)).toBe(usdt('1000'));
    expect(await checkIntegrity(admin)).toEqual(clean);
  });

  it('only allocates confirmed, unattributed receipts, one allocation at a time', async () => {
    const alice = await createUser();
    const wallet = '0x5555555555555555555555555555555555555555';
    await simDeposit(GROUP, usdt('50'), 1, { from: wallet }); // not yet confirmed
    await tick();
    const pending = await one<{ id: string }>(admin, 'select id from public.deposits');
    await expect(allocate(pending.id, 'assignment', [{ userId: alice, amount: '50' }])).rejects.toMatchObject({ code: 'invalid_state' });

    await mineBlocks(5);
    await tick();
    const a = await allocate(pending.id, 'assignment', [{ userId: alice, amount: '50' }]);
    await expect(allocate(pending.id, 'assignment', [{ userId: alice, amount: '50' }])).rejects.toMatchObject({ code: 'already_allocated' });
    await withTransaction(web, (db) => cancelAllocation(db, { allocationId: a.id, reason: 'Wrong member picked', actor: staff() }));
    expect(await post(a.id)).toBe('unchanged');
    expect(await balanceOf('user_cash', tokenId, alice)).toBe(0n);
    // Cancelled frees the receipt for a new allocation.
    const b = await allocate(pending.id, 'assignment', [{ userId: alice, amount: '50' }]);
    expect(await post(b.id)).toBe('posted');
  });

  it('flags an administrator allocating to themselves', async () => {
    const d = await unattributed('80');
    await allocate(d.id, 'assignment', [{ userId: adminId, amount: '80' }]);
    expect((await admin.query("select count(*)::int as n from public.risk_events where kind = 'admin_self_allocation' and severity = 'high'")).rows[0].n).toBe(1);
  });

  it('keeps allocation lines and posted allocations immutable for the web role', async () => {
    const alice = await createUser();
    const d = await unattributed('90');
    const a = await allocate(d.id, 'assignment', [{ userId: alice, amount: '90' }]);
    await expect(web.query('update public.allocation_lines set amount_base = 1 where allocation_id = $1', [a.id])).rejects.toThrow();
    await post(a.id);
    await expect(web.query("update public.allocations set status = 'cancelled' where id = $1", [a.id])).rejects.toThrow(/only a pending allocation/);
  });
});

describe('corrections', () => {
  it('reverses a credit back to unassigned, then the receipt can be allocated again', async () => {
    const alice = await createUser();
    const bob = await createUser();
    const d = await unattributed('200');
    const a = await allocate(d.id, 'assignment', [{ userId: alice, amount: '200' }]);
    await post(a.id);

    const c = await withTransaction(web, (db) => createCorrection(db, { depositId: d.id, reason: 'Was actually Bob’s transfer', staffUserId: adminId, actor: staff() }));
    expect(await withTransaction(worker, (db) => postCorrection(db, c.id, service))).toBe('posted');
    expect(await balanceOf('user_cash', tokenId, alice)).toBe(0n);
    expect(await balanceOf('suspense_deposits', tokenId)).toBe(usdt('200'));
    expect(await one(admin, 'select status, status_reason, user_id from public.deposits where id = $1', [d.id])).toEqual({ status: 'under_review', status_reason: 'corrected', user_id: null });
    expect((await one<{ status: string }>(admin, 'select status from public.allocations where id = $1', [a.id])).status).toBe('reversed');

    const again = await allocate(d.id, 'assignment', [{ userId: bob, amount: '200' }]);
    await post(again.id);
    expect(await balanceOf('user_cash', tokenId, bob)).toBe(usdt('200'));
    expect(await checkIntegrity(admin)).toEqual(clean);
  });

  it('fails a correction when the member has already spent the credit, leaving balances untouched', async () => {
    const alice = await createUser();
    const d = await unattributed('100');
    const a = await allocate(d.id, 'assignment', [{ userId: alice, amount: '100' }]);
    await post(a.id);
    // Alice moves the cash out (e.g. a reserved withdrawal).
    const cash = await ensureAccount(worker, 'user_cash', tokenId, { userId: alice });
    const reserved = await ensureAccount(worker, 'user_reserved', tokenId, { userId: alice });
    await postEntry(worker, { idempotencyKey: 'test:spend', eventType: 'test', sourceType: 'test', sourceId: 'x', description: 'spend', postedBy: 'service:test', lines: transfer(cash, reserved, usdt('60')) });

    const c = await withTransaction(web, (db) => createCorrection(db, { depositId: d.id, reason: 'Wrong member again', staffUserId: adminId, actor: staff() }));
    const err = await withTransaction(worker, (db) => postCorrection(db, c.id, service)).catch((e: { code?: string; message: string }) => e);
    expect((err as { code?: string }).code).toBe('P0002');
    await withTransaction(worker, (db) => failCorrection(db, c.id, (err as Error).message));
    expect((await one<{ status: string }>(admin, 'select status from public.deposit_corrections where id = $1', [c.id])).status).toBe('failed');
    expect(await balanceOf('user_cash', tokenId, alice)).toBe(usdt('40'));
    expect(await checkIntegrity(admin)).toEqual(clean);
  });
});

describe('manual payouts', () => {
  const adapter = async (db: Db) => new SimulatedChainAdapter(await getNetwork(db, 'sim-evm'), db);
  const deps = (): PayoutDeps => ({
    custody: new ManualCustodyProvider(worker),
    adapterFor: async (id, db) => new SimulatedChainAdapter(await getNetwork(db, id), db),
    screening: new MockScreeningProvider({} as NodeJS.ProcessEnv),
  });

  /** Member with 500 credited, a confirmed 100 withdrawal, and the group wallet funded on chain. */
  async function reservedWithdrawal() {
    const alice = await createUser();
    const d = await unattributed('500');
    await post((await allocate(d.id, 'assignment', [{ userId: alice, amount: '500' }])).id);
    const w = await withTransaction(web, async (db) =>
      createWithdrawal(db, await adapter(db), { userId: alice, networkId, destination: DEST, amount: '100', idempotencyKey: `k-${Math.random()}`, actor: { type: 'user', id: alice } }),
    );
    await withTransaction(web, (db) => confirmWithdrawal(db, { userId: alice, withdrawalId: w.id, mfaVerified: true, actor: { type: 'user', id: alice } }));
    await admin.query("update public.withdrawal_destinations set usable_after = now() - interval '1 minute'");
    return { alice, w };
  }

  const record = (withdrawalId: string, txHash: string) =>
    withTransaction(web, async (db) => recordManualPayout(db, await adapter(db), { withdrawalId, txHash, note: 'Sent from Trust Wallet', staffUserId: adminId, actor: staff() }));

  it('waits for the admin, refuses a wrong hash, then settles only the verified transfer', async () => {
    const { alice, w } = await reservedWithdrawal();
    expect((await processWithdrawal(worker, deps(), w.id)).outcome).toBe('submitted');
    expect((await processWithdrawal(worker, deps(), w.id)).outcome).toBe('submitted'); // still waiting, same attempt
    expect((await listManualPayoutTasks(web)).map((t) => t.withdrawalId)).toEqual([w.id]);

    const net = usdt('99'); // 100 minus the 1 fee
    const wrongAmount = await insertSimTransfer(admin, { networkId, tokenContract: contract, from: GROUP, to: DEST, amount: usdt('98'), delayBlocks: -1 });
    await expect(record(w.id, wrongAmount.txHash)).rejects.toMatchObject({ code: 'tx_mismatch' });
    const wrongSender = await insertSimTransfer(admin, { networkId, tokenContract: contract, from: '0x6666666666666666666666666666666666666666', to: DEST, amount: net, delayBlocks: -1 });
    await expect(record(w.id, wrongSender.txHash)).rejects.toMatchObject({ code: 'tx_mismatch' });

    const paid = await insertSimTransfer(admin, { networkId, tokenContract: contract, from: GROUP, to: DEST, amount: net, delayBlocks: -1 });
    await record(w.id, paid.txHash);
    await expect(record(w.id, paid.txHash)).rejects.toMatchObject({ code: 'already_recorded' });
    expect((await admin.query("select count(*)::int as n from public.risk_events where kind = 'admin_manual_payout'")).rows[0].n).toBe(1);

    expect((await processWithdrawal(worker, deps(), w.id)).outcome).toBe('broadcast');
    await mineBlocks(5);
    expect(await monitorWithdrawal(worker, deps(), w.id)).toBe('confirmed');
    expect(await balanceOf('user_cash', tokenId, alice)).toBe(usdt('400'));
    expect(await balanceOf('user_reserved', tokenId, alice)).toBe(0n);
    expect(await balanceOf('treasury_hot', tokenId)).toBe(usdt('500') - net);
    expect(await checkIntegrity(admin)).toEqual(clean);
  });

  it('releases the reservation when the admin declines to pay', async () => {
    const { alice, w } = await reservedWithdrawal();
    await processWithdrawal(worker, deps(), w.id);
    await withTransaction(web, (db) => cancelManualPayout(db, { withdrawalId: w.id, note: 'Destination looks wrong', staffUserId: adminId, actor: staff() }));
    expect((await processWithdrawal(worker, deps(), w.id)).outcome).toBe('failed');
    expect(await balanceOf('user_cash', tokenId, alice)).toBe(usdt('500'));
    expect(await balanceOf('user_reserved', tokenId, alice)).toBe(0n);
  });
});
