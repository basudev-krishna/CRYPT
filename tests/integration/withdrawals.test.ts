import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { admin, balanceOf, closePools, createUser, mineBlocks, resetAppData, simNetwork, simToken, usdt, worker, web } from '../helpers/db';
import { withTransaction, one, type Db } from '../../src/server/db-core';
import { ensureAccount, postEntry, transfer, checkIntegrity } from '../../src/server/ledger/ledger';
import { insertSimTransfer, SimulatedChainAdapter } from '../../src/server/chains/simulated';
import { SimulatedCustodyProvider } from '../../src/server/custody/simulated';
import { CustodyUnavailableError, type CustodyProvider } from '../../src/server/custody/types';
import { MockScreeningProvider } from '../../src/server/compliance/compliance';
import { getNetwork } from '../../src/server/chains/registry';
import {
  cancelWithdrawal,
  confirmWithdrawal,
  createWithdrawal,
  monitorWithdrawal,
  processWithdrawal,
  reviewWithdrawal,
  type PayoutDeps,
} from '../../src/server/withdrawals/service';

const HOT = '0x0000000000000000000000000000000000000a07';
const DEST = '0x2222222222222222222222222222222222222222';
let tokenId: number;
let networkId: number;
let contract: string;

beforeEach(async () => {
  await resetAppData();
  const t = await simToken();
  tokenId = t.id;
  contract = t.contract_address;
  networkId = (await simNetwork()).id;
  // Operator capital in the hot wallet, on chain and in the ledger.
  await insertSimTransfer(admin, { networkId, tokenContract: contract, from: '0x0000000000000000000000000000000000000001', to: HOT, amount: usdt('100000'), delayBlocks: -20 });
  const hot = await ensureAccount(worker, 'treasury_hot', tokenId);
  const eq = await ensureAccount(worker, 'owner_equity', tokenId);
  await postEntry(worker, { idempotencyKey: 'test:operator-capital', eventType: 'capital', sourceType: 'test', sourceId: 'cap', description: 'operator capital', postedBy: 'service:test', lines: transfer(hot, eq, usdt('100000')) });
});
afterAll(closePools);

const actorFor = (id: string) => ({ type: 'user' as const, id });

async function fundUser(userId: string, amount: string) {
  const eq = await ensureAccount(worker, 'owner_equity', tokenId);
  const cash = await ensureAccount(worker, 'user_cash', tokenId, { userId });
  // Represents credited deposits + allocated results already in the customer's cash balance.
  await postEntry(worker, { idempotencyKey: `test:fund:${userId}:${amount}`, eventType: 'test_fund', sourceType: 'test', sourceId: userId, description: 'test funding', postedBy: 'service:test', lines: transfer(eq, cash, usdt(amount)) });
}

const adapter = async (db: Db = web) => new SimulatedChainAdapter(await getNetwork(db, 'sim-evm'), db);

function deps(custody: CustodyProvider = new SimulatedCustodyProvider(worker)): PayoutDeps {
  return { custody, adapterFor: async (id, db) => new SimulatedChainAdapter(await getNetwork(db, id), db), screening: new MockScreeningProvider({} as NodeJS.ProcessEnv) };
}

async function request(userId: string, amount: string, dest = DEST, key = `k-${Math.random()}`) {
  return withTransaction(web, async (db) => createWithdrawal(db, await adapter(db), { userId, networkId, destination: dest, amount, idempotencyKey: key, actor: actorFor(userId) }));
}
const confirm = (userId: string, id: string, mfa = true) => withTransaction(web, (db) => confirmWithdrawal(db, { userId, withdrawalId: id, mfaVerified: mfa, actor: actorFor(userId) }));
const endCooldown = () => admin.query("update public.withdrawal_destinations set usable_after = now() - interval '1 minute'");
const status = async (id: string) => (await one<{ status: string }>(admin, 'select status from public.withdrawal_requests where id = $1', [id])).status;

describe('withdrawals', () => {
  it('reserves, pays out once, settles with fee, and leaves 85 of 105 (spec example)', async () => {
    const u = await createUser();
    await fundUser(u, '105'); // 100 deposit + 5 allocated profit
    const w = await request(u, '20');
    expect(w.status).toBe('pending_verification');
    expect(w.fee).toBe(usdt('1'));

    await expect(confirm(u, w.id, false)).rejects.toMatchObject({ code: 'mfa_required' });
    await confirm(u, w.id);
    expect(await balanceOf('user_cash', tokenId, u)).toBe(usdt('85'));
    expect(await balanceOf('user_reserved', tokenId, u)).toBe(usdt('20'));

    // New destination is cooling down: held, nothing sent.
    expect((await processWithdrawal(worker, deps(), w.id)).outcome).toBe('held');
    await endCooldown();
    expect((await processWithdrawal(worker, deps(), w.id)).outcome).toBe('broadcast');
    expect((await processWithdrawal(worker, deps(), w.id)).outcome).toBe('noop'); // retry is harmless

    // Not settled on broadcast; only after the required confirmations.
    expect(await monitorWithdrawal(worker, deps(), w.id)).toBe('pending');
    expect(await status(w.id)).toBe('broadcast');
    await mineBlocks(5);
    expect(await monitorWithdrawal(worker, deps(), w.id)).toBe('confirmed');

    expect(await balanceOf('user_reserved', tokenId, u)).toBe(0n);
    expect(await balanceOf('user_cash', tokenId, u)).toBe(usdt('85'));
    expect(await balanceOf('fee_revenue', tokenId)).toBe(usdt('1'));
    expect(await balanceOf('treasury_hot', tokenId)).toBe(usdt('100000') - usdt('19'));
    const sent = await admin.query('select amount_base::text from public.sim_chain_transfers where to_address = $1', [DEST]);
    expect(sent.rows).toEqual([{ amount_base: '19000000' }]);
    expect(await checkIntegrity(admin)).toEqual({ unbalancedTokens: [], cacheMismatches: [] });
  });

  it('never lets concurrent withdrawals spend the same balance', async () => {
    const u = await createUser();
    await fundUser(u, '100');
    const reqs = [await request(u, '60'), await request(u, '60'), await request(u, '60')];
    const results = await Promise.allSettled(reqs.map((r) => confirm(u, r.id)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason.code === 'insufficient_balance')).toBe(true);
    expect(await balanceOf('user_cash', tokenId, u)).toBe(usdt('40'));
    expect(await balanceOf('user_reserved', tokenId, u)).toBe(usdt('60'));
  });

  it('rejects withdrawals above the eligible balance', async () => {
    const u = await createUser();
    await fundUser(u, '100');
    await expect(request(u, '100.000001')).rejects.toMatchObject({ code: 'policy_rejected' });
  });

  it('sends each payout to custody exactly once under concurrent processing', async () => {
    const u = await createUser();
    await fundUser(u, '100');
    const w = await request(u, '50');
    await confirm(u, w.id);
    await endCooldown();
    await Promise.allSettled([1, 2, 3, 4].map(() => processWithdrawal(worker, deps(), w.id)));
    expect((await admin.query('select count(*)::int as n from public.withdrawal_transactions')).rows[0].n).toBe(1);
    expect((await admin.query('select count(*)::int as n from public.sim_chain_transfers where to_address = $1', [DEST])).rows[0].n).toBe(1);
  });

  it('retries a custody outage with the same idempotency key without duplicating the payout', async () => {
    const u = await createUser();
    await fundUser(u, '100');
    const w = await request(u, '30');
    await confirm(u, w.id);
    await endCooldown();
    const real = new SimulatedCustodyProvider(worker);
    const flaky: CustodyProvider = {
      ...real,
      name: real.name,
      isSimulated: true,
      supportsNetwork: (c) => real.supportsNetwork(c),
      createDepositAddress: (a) => real.createDepositAddress(a),
      getTransfer: (id, n) => real.getTransfer(id, n),
      submitTransfer: async () => {
        throw new CustodyUnavailableError('custody timeout');
      },
    };
    await expect(processWithdrawal(worker, deps(flaky), w.id)).rejects.toThrow(/timeout/);
    expect(await status(w.id)).toBe('processing');
    expect((await processWithdrawal(worker, deps(real), w.id)).outcome).toBe('broadcast');
    const attempts = await admin.query('select custody_request_id from public.withdrawal_transactions');
    expect(attempts.rows).toEqual([{ custody_request_id: `wd:${w.id}:1` }]);
  });

  it('releases the reservation when the payout reverts on chain', async () => {
    const u = await createUser();
    await fundUser(u, '100');
    const w = await request(u, '25', '0x000000000000000000000000000000000000dead');
    await confirm(u, w.id);
    await endCooldown();
    expect((await processWithdrawal(worker, deps(), w.id)).outcome).toBe('broadcast');
    await mineBlocks(5);
    expect(await monitorWithdrawal(worker, deps(), w.id)).toBe('failed');
    expect(await status(w.id)).toBe('failed');
    expect(await balanceOf('user_cash', tokenId, u)).toBe(usdt('100'));
    expect(await balanceOf('user_reserved', tokenId, u)).toBe(0n);
    expect(await balanceOf('treasury_hot', tokenId)).toBe(usdt('100000'));
  });

  it('honours the emergency pause for new requests and queued payouts', async () => {
    const u = await createUser();
    await fundUser(u, '100');
    const w = await request(u, '20');
    await confirm(u, w.id);
    await endCooldown();
    await admin.query("update public.system_controls set enabled = true where key = 'withdrawals_paused'");
    await expect(request(u, '10')).rejects.toMatchObject({ code: 'policy_rejected' });
    expect((await processWithdrawal(worker, deps(), w.id)).outcome).toBe('held');
    expect(await status(w.id)).toBe('reserved');
  });

  it('routes large withdrawals to manual review and requires a documented decision', async () => {
    const u = await createUser();
    const staff = await createUser();
    await fundUser(u, '6000');
    const w = await request(u, '6000');
    await confirm(u, w.id);
    await endCooldown();
    expect((await processWithdrawal(worker, deps(), w.id)).outcome).toBe('manual_review');
    await expect(withTransaction(web, (db) => reviewWithdrawal(db, { withdrawalId: w.id, decision: 'approve', note: 'ok', staffUserId: staff, actor: { type: 'staff', id: staff } }))).rejects.toThrow(/note/);
    await expect(withTransaction(web, (db) => reviewWithdrawal(db, { withdrawalId: w.id, decision: 'approve', note: 'reviewing my own request', staffUserId: u, actor: { type: 'staff', id: u } }))).rejects.toThrow(/own/);
    await withTransaction(web, (db) => reviewWithdrawal(db, { withdrawalId: w.id, decision: 'approve', note: 'Source of funds verified by compliance', staffUserId: staff, actor: { type: 'staff', id: staff } }));
    expect((await processWithdrawal(worker, deps(), w.id)).outcome).toBe('broadcast');
  });

  it('lets the user cancel before processing and restores the balance', async () => {
    const u = await createUser();
    await fundUser(u, '100');
    const w = await request(u, '40');
    await confirm(u, w.id);
    await withTransaction(web, (db) => cancelWithdrawal(db, { userId: u, withdrawalId: w.id, actor: actorFor(u) }));
    expect(await status(w.id)).toBe('cancelled');
    expect(await balanceOf('user_cash', tokenId, u)).toBe(usdt('100'));
    // State machine: a cancelled withdrawal can't be revived.
    await expect(admin.query("update public.withdrawal_requests set status = 'reserved' where id = $1", [w.id])).rejects.toThrow(/final|illegal/);
  });

  it('does not retry a submitted payout attempt while withdrawals are paused', async () => {
    const u = await createUser();
    await fundUser(u, '100');
    const w = await request(u, '30');
    await confirm(u, w.id);
    await endCooldown();
    const real = new SimulatedCustodyProvider(worker);
    const down: CustodyProvider = { ...real, name: real.name, isSimulated: true, supportsNetwork: (c) => real.supportsNetwork(c), createDepositAddress: (a) => real.createDepositAddress(a), getTransfer: (id, n) => real.getTransfer(id, n), submitTransfer: async () => { throw new CustodyUnavailableError('custody timeout'); } };
    await expect(processWithdrawal(worker, deps(down), w.id)).rejects.toThrow(/timeout/);
    expect(await status(w.id)).toBe('processing');
    await admin.query("update public.system_controls set enabled = true where key = 'withdrawals_paused'");
    expect((await processWithdrawal(worker, deps(real), w.id)).outcome).toBe('held');
    expect((await admin.query('select count(*)::int as n from public.sim_chain_transfers where to_address = $1', [DEST])).rows[0].n).toBe(0);
    // Resuming sends the original attempt (same key), exactly once.
    await admin.query("update public.system_controls set enabled = false where key = 'withdrawals_paused'");
    expect((await processWithdrawal(worker, deps(real), w.id)).outcome).toBe('broadcast');
    expect((await admin.query('select custody_request_id from public.withdrawal_transactions')).rows).toEqual([{ custody_request_id: `wd:${w.id}:1` }]);
  });

  it('holds payouts for restricted accounts even after a manual approval', async () => {
    const u = await createUser();
    const staff = await createUser();
    await fundUser(u, '100');
    const w = await request(u, '20');
    await confirm(u, w.id);
    await endCooldown();
    await admin.query("update public.user_profiles set account_status = 'restricted' where user_id = $1", [u]);
    await withTransaction(web, (db) => reviewWithdrawal(db, { withdrawalId: w.id, decision: 'approve', note: 'Approving despite restriction (should not bypass)', staffUserId: staff, actor: { type: 'staff', id: staff } }));
    expect((await processWithdrawal(worker, deps(), w.id)).outcome).toBe('held');
    expect(await status(w.id)).toBe('reserved');
    expect((await admin.query('select count(*)::int as n from public.withdrawal_transactions')).rows[0].n).toBe(0);
  });

  it('holds payouts when the latest reconciliation run errored', async () => {
    const u = await createUser();
    await fundUser(u, '100');
    const w = await request(u, '20');
    await confirm(u, w.id);
    await endCooldown();
    await admin.query("insert into public.reconciliation_runs (status, triggered_by, started_at, finished_at) values ('ok', 'test', now() - interval '1 hour', now() - interval '1 hour'), ('error', 'test', now(), now())");
    expect((await processWithdrawal(worker, deps(), w.id)).outcome).toBe('held');
  });

  it('never releases a reservation when custody reports failure but the chain shows the payout succeeded', async () => {
    const u = await createUser();
    await fundUser(u, '100');
    const w = await request(u, '20');
    await confirm(u, w.id);
    await endCooldown();
    const real = new SimulatedCustodyProvider(worker);
    const lying: CustodyProvider = { ...real, name: real.name, isSimulated: true, supportsNetwork: (c) => real.supportsNetwork(c), createDepositAddress: (a) => real.createDepositAddress(a), submitTransfer: (r) => real.submitTransfer(r), getTransfer: async (id, n) => ({ ...(await real.getTransfer(id, n))!, status: 'failed', error: 'custody says failed' }) };
    expect((await processWithdrawal(worker, deps(real), w.id)).outcome).toBe('broadcast');
    await mineBlocks(5);
    expect(await monitorWithdrawal(worker, deps(lying), w.id)).toBe('pending');
    expect(await monitorWithdrawal(worker, deps(lying), w.id)).toBe('pending');
    expect(await status(w.id)).toBe('broadcast');
    expect(await balanceOf('user_reserved', tokenId, u)).toBe(usdt('20')); // not released to cash
    expect(await balanceOf('user_cash', tokenId, u)).toBe(usdt('80'));
    const events = await admin.query("select severity::text from public.risk_events where kind = 'payout_status_conflict'");
    expect(events.rows).toEqual([{ severity: 'critical' }]); // deduplicated
    expect((await admin.query("select enabled from public.system_controls where key = 'withdrawals_paused'")).rows[0].enabled).toBe(true);
  });

  it('does not settle a mined transaction that did not pay the requested destination', async () => {
    const u = await createUser();
    await fundUser(u, '100');
    const w = await request(u, '20');
    await confirm(u, w.id);
    await endCooldown();
    const real = new SimulatedCustodyProvider(worker);
    const misdirect: CustodyProvider = { ...real, name: real.name, isSimulated: true, supportsNetwork: (c) => real.supportsNetwork(c), createDepositAddress: (a) => real.createDepositAddress(a), getTransfer: (id, n) => real.getTransfer(id, n), submitTransfer: (r) => real.submitTransfer({ ...r, toAddress: '0x3333333333333333333333333333333333333333' }) };
    expect((await processWithdrawal(worker, deps(misdirect), w.id)).outcome).toBe('broadcast');
    await mineBlocks(5);
    expect(await monitorWithdrawal(worker, deps(real), w.id)).toBe('pending');
    expect(await status(w.id)).toBe('broadcast');
    expect(await balanceOf('user_reserved', tokenId, u)).toBe(usdt('20'));
    expect((await admin.query("select count(*)::int as n from public.risk_events where kind = 'payout_verification_mismatch' and severity = 'critical'")).rows[0].n).toBe(1);
  });

  it('does not let one user act on another user\'s withdrawal', async () => {
    const u = await createUser();
    const other = await createUser();
    await fundUser(u, '100');
    const w = await request(u, '20');
    await expect(confirm(other, w.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(withTransaction(web, (db) => cancelWithdrawal(db, { userId: other, withdrawalId: w.id, actor: actorFor(other) }))).rejects.toMatchObject({ code: 'not_found' });
  });
});
