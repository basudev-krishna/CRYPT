import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { admin, balanceOf, closePools, createUser, mineBlocks, resetAppData, simAdapter, simDeposit, simToken, usdt, worker } from '../helpers/db';
import { creditDeposit, getDepositInstructions, ingestNetwork, investigateTransaction, refreshDeposit, reviewDeposit } from '../../src/server/deposits/service';
import { SimulatedCustodyProvider } from '../../src/server/custody/simulated';
import { SimulatedChainAdapter } from '../../src/server/chains/simulated';
import { getNetwork } from '../../src/server/chains/registry';
import { withTransaction, one } from '../../src/server/db-core';
import { checkIntegrity } from '../../src/server/ledger/ledger';

const actor = { type: 'service' as const, id: 'test' };
let tokenId: number;

beforeEach(async () => {
  await resetAppData();
  tokenId = (await simToken()).id;
});
afterAll(closePools);

async function addressFor(userId: string) {
  const net = await getNetwork(worker, 'sim-evm');
  const ins = await getDepositInstructions(web(), new SimulatedCustodyProvider(worker), userId, net.id, actor);
  return ins.address;
}
// Address issuance is a web action; use the worker pool here for simplicity (both roles may insert).
const web = () => worker;

/** Ingest, refresh and credit everything once (one worker "tick"). */
async function tick() {
  const adapter = await simAdapter();
  await ingestNetwork(worker, adapter);
  const ids = (await worker.query("select id from public.deposits where status in ('detected', 'confirming', 'confirmed')")).rows.map((r) => r.id as string);
  for (const id of ids) {
    await withTransaction(worker, (db) => refreshDeposit(db, new SimulatedChainAdapter(adapter.network, db), id));
    await withTransaction(worker, (db) => creditDeposit(db, id));
  }
}

async function depositRow() {
  return one<{ id: string; status: string; status_reason: string | null; confirmations: number }>(admin, 'select id, status, status_reason, confirmations from public.deposits');
}

describe('deposit verification and crediting', () => {
  it('requires approved KYC before issuing a deposit address', async () => {
    const user = await createUser({ kyc: 'pending' });
    await expect(addressFor(user)).rejects.toMatchObject({ code: 'kyc_required' });
  });

  it('does not credit until the required confirmations are reached, then credits exactly once', async () => {
    const user = await createUser();
    const address = await addressFor(user);
    await simDeposit(address, usdt('100'), 1); // network requires 3

    await tick();
    expect((await depositRow()).status).toBe('confirming');
    expect(await balanceOf('user_cash', tokenId, user)).toBe(0n);
    expect(await balanceOf('user_pending_subscription', tokenId, user)).toBe(0n);

    await mineBlocks(5);
    await tick();
    const d = await depositRow();
    expect(d.status).toBe('credited');
    // Auto-subscribe moves the credited cash into the pending subscription.
    expect(await balanceOf('user_pending_subscription', tokenId, user)).toBe(usdt('100'));
    expect(await balanceOf('treasury_hot', tokenId)).toBe(usdt('100'));

    // Duplicate events: re-scanning, re-refreshing and re-crediting change nothing.
    await admin.query('delete from public.network_scan_state');
    await tick();
    await tick();
    await withTransaction(worker, (db) => creditDeposit(db, d.id));
    expect((await admin.query('select count(*)::int as n from public.deposits')).rows[0].n).toBe(1);
    expect((await admin.query("select count(*)::int as n from public.journal_entries where event_type = 'deposit_credit'")).rows[0].n).toBe(1);
    expect(await balanceOf('treasury_hot', tokenId)).toBe(usdt('100'));
    expect(await checkIntegrity(admin)).toEqual({ unbalancedTokens: [], cacheMismatches: [] });
  });

  it('credits concurrently processed duplicate events only once', async () => {
    const user = await createUser();
    const address = await addressFor(user);
    await simDeposit(address, usdt('75'), 10);
    const adapter = await simAdapter();
    await ingestNetwork(worker, adapter);
    const id = (await depositRow()).id;
    await withTransaction(worker, (db) => refreshDeposit(db, new SimulatedChainAdapter(adapter.network, db), id));
    await Promise.allSettled([1, 2, 3, 4].map(() => withTransaction(worker, (db) => creditDeposit(db, id))));
    expect((await admin.query("select count(*)::int as n from public.journal_entries where event_type in ('deposit_credit', 'deposit_received')")).rows[0].n).toBe(2);
    expect(await balanceOf('treasury_hot', tokenId)).toBe(usdt('75'));
  });

  it('holds deposits below the $50 minimum in suspense under review (backend-enforced)', async () => {
    const user = await createUser();
    const address = await addressFor(user);
    await simDeposit(address, usdt('49.999999'), 10);
    await tick();
    const d = await depositRow();
    expect(d.status).toBe('under_review');
    expect(d.status_reason).toContain('below_minimum');
    expect(await balanceOf('suspense_deposits', tokenId)).toBe(usdt('49.999999'));
    expect(await balanceOf('user_cash', tokenId, user)).toBe(0n);

    // The minimum cannot be waived in review: approval is refused, rejection sends it to recovery.
    await expect(withTransaction(worker, (db) => reviewDeposit(db, d.id, 'approve', 'short', actor))).rejects.toThrow(/note/);
    await expect(withTransaction(worker, (db) => reviewDeposit(db, d.id, 'approve', 'Customer confirmed; shortfall accepted', actor))).rejects.toMatchObject({ code: 'below_minimum' });
    expect((await depositRow()).status).toBe('under_review');
    await withTransaction(worker, (db) => reviewDeposit(db, d.id, 'reject', 'Below minimum; return to sender via recovery', actor));
    expect((await depositRow()).status).toBe('recovery_required');
    expect(await balanceOf('suspense_deposits', tokenId)).toBe(usdt('49.999999'));
    expect(await balanceOf('user_cash', tokenId, user)).toBe(0n);
    expect((await admin.query("select count(*)::int as n from public.journal_entries where event_type = 'deposit_credit'")).rows[0].n).toBe(0);
  });

  it('credits a reviewed deposit once a different staff member approves it', async () => {
    const user = await createUser();
    const staff = await createUser();
    const address = await addressFor(user);
    await simDeposit(address, usdt('100'), 10, { from: '0x000000000000000000000000000000000000bad0' });
    await tick();
    const d = await depositRow();
    expect(d.status).toBe('under_review');
    const self = { type: 'staff' as const, id: user };
    await expect(withTransaction(worker, (db) => reviewDeposit(db, d.id, 'approve', 'Approving my own deposit here', self))).rejects.toMatchObject({ code: 'conflict_of_interest' });
    await withTransaction(worker, (db) => reviewDeposit(db, d.id, 'approve', 'Source reviewed and cleared by compliance', { type: 'staff', id: staff }));
    await withTransaction(worker, (db) => reviewDeposit(db, d.id, 'approve', 'Second approval must not double credit', { type: 'staff', id: staff })).catch(() => undefined);
    expect((await depositRow()).status).toBe('credited');
    expect((await admin.query("select count(*)::int as n from public.journal_entries where event_type = 'deposit_credit'")).rows[0].n).toBe(1);
  });

  it('does not credit deposits for frozen accounts', async () => {
    const user = await createUser();
    const address = await addressFor(user);
    await admin.query("update public.user_profiles set account_status = 'frozen' where user_id = $1", [user]);
    await simDeposit(address, usdt('100'), 10);
    await tick();
    const d = await depositRow();
    expect(d.status).toBe('under_review');
    expect(d.status_reason).toContain('account_not_active');
    expect(await balanceOf('user_cash', tokenId, user)).toBe(0n);
    expect(await balanceOf('user_pending_subscription', tokenId, user)).toBe(0n);
  });

  it('ignores out-of-order credit attempts before confirmation', async () => {
    const user = await createUser();
    const address = await addressFor(user);
    await simDeposit(address, usdt('100'), 10);
    await ingestNetwork(worker, await simAdapter());
    const d = await depositRow();
    expect(d.status).toBe('detected');
    expect(await withTransaction(worker, (db) => creditDeposit(db, d.id))).toBe('unchanged');
    expect(await balanceOf('treasury_hot', tokenId)).toBe(0n);
  });

  it('fails a deposit that is reorged out and flags it for recovery if it reappears', async () => {
    const user = await createUser();
    const address = await addressFor(user);
    await simDeposit(address, usdt('100'), 1);
    await tick();
    expect((await depositRow()).status).toBe('confirming');
    const sim = await one<Record<string, unknown>>(admin, 'select network_id, tx_hash, block_number, token_contract, from_address, to_address, amount_base from public.sim_chain_transfers');
    await admin.query('delete from public.sim_chain_transfers');
    await tick();
    expect((await depositRow()).status).toBe('failed');
    // Re-mined in a later block with the same hash and log index.
    await admin.query(
      'insert into public.sim_chain_transfers (network_id, tx_hash, block_number, token_contract, from_address, to_address, amount_base) values ($1, $2, public.sim_block_number() - 10, $3, $4, $5, $6)',
      [sim.network_id, sim.tx_hash, sim.token_contract, sim.from_address, sim.to_address, sim.amount_base],
    );
    await admin.query('delete from public.network_scan_state');
    await tick();
    await tick();
    expect((await depositRow()).status).toBe('recovery_required');
    expect((await admin.query("select count(*)::int as n from public.risk_events where kind = 'deposit_reappeared_after_reorg'")).rows[0].n).toBe(1);
    expect(await balanceOf('user_cash', tokenId, user)).toBe(0n);
    expect(await balanceOf('treasury_hot', tokenId)).toBe(0n);
  });

  it('marks reverted transfers as failed and never credits them', async () => {
    const user = await createUser();
    const address = await addressFor(user);
    const { txHash } = await simDeposit(address, usdt('100'), 10, { success: false });
    // A reverted transfer emits no log, so the scanner never sees it; investigation classifies it.
    await tick();
    expect((await admin.query('select count(*)::int as n from public.deposits')).rows[0].n).toBe(0);
    const res = await withTransaction(worker, async (db) => investigateTransaction(db, new SimulatedChainAdapter((await simAdapter()).network, db), txHash, actor));
    expect(res.outcome).toBe('reverted');
  });

  it('flags transfers of non-allowlisted tokens as recovery_required without crediting', async () => {
    const user = await createUser();
    const address = await addressFor(user);
    const { txHash } = await simDeposit(address, usdt('500'), 10, { contract: '0x000000000000000000000000000000000000beef' });
    await tick();
    expect((await admin.query('select count(*)::int as n from public.deposits')).rows[0].n).toBe(0); // scanner ignores it
    const res = await withTransaction(worker, async (db) => investigateTransaction(db, new SimulatedChainAdapter((await simAdapter()).network, db), txHash, actor));
    expect(res.outcome).toBe('recorded');
    const d = await depositRow();
    expect(d.status).toBe('recovery_required');
    expect(d.status_reason).toBe('unsupported_token');
    expect(await balanceOf('treasury_hot', tokenId)).toBe(0n);
  });

  it('sends deposits from high-risk source addresses to review', async () => {
    const user = await createUser();
    const address = await addressFor(user);
    await simDeposit(address, usdt('100'), 10, { from: '0x000000000000000000000000000000000000bad0' });
    await tick();
    const d = await depositRow();
    expect(d.status).toBe('under_review');
    expect(d.status_reason).toContain('source_address_risk');
  });

  it('does not treat a transfer on another network as a deposit', async () => {
    const user = await createUser();
    const address = await addressFor(user);
    // A second network with the same token contract string and the same address.
    const net2 = await one<{ id: number }>(
      admin,
      "insert into public.supported_networks (code, name, family, is_testnet, required_confirmations, status) values ('test-sim-2', 'Test sim 2', 'simulated', true, 3, 'active') returning id",
    );
    const token = await simToken();
    await admin.query(
      "insert into public.supported_tokens (network_id, symbol, name, contract_address, decimals, is_test_token, status, min_deposit_base) values ($1, 'tUSDT', 'x', $2, 6, true, 'active', 50000000)",
      [net2.id, token.contract_address],
    );
    await admin.query(
      "insert into public.sim_chain_transfers (network_id, tx_hash, block_number, token_contract, from_address, to_address, amount_base) values ($1, 'sim:0xother', public.sim_block_number() - 20, $2, '0x1111111111111111111111111111111111111111', $3, 100000000)",
      [net2.id, token.contract_address, address],
    );
    await tick(); // scans sim-evm only
    const net2Adapter = new SimulatedChainAdapter(await getNetwork(worker, net2.id), worker);
    await ingestNetwork(worker, net2Adapter); // address is not registered on network 2
    expect((await admin.query('select count(*)::int as n from public.deposits')).rows[0].n).toBe(0);
    await admin.query('delete from public.sim_chain_transfers where network_id = $1', [net2.id]);
    await admin.query('delete from public.chain_transactions where network_id = $1', [net2.id]);
    await admin.query('delete from public.network_scan_state where network_id = $1', [net2.id]);
    await admin.query('delete from public.supported_tokens where network_id = $1', [net2.id]);
  });

  it('defers crediting while deposits are paused', async () => {
    const user = await createUser();
    const address = await addressFor(user);
    await admin.query("update public.system_controls set enabled = true where key = 'deposits_paused'");
    await simDeposit(address, usdt('100'), 10);
    await tick();
    expect((await depositRow()).status).toBe('confirmed');
    expect(await balanceOf('suspense_deposits', tokenId)).toBe(usdt('100')); // received, not credited
    await admin.query("update public.system_controls set enabled = false where key = 'deposits_paused'");
    await tick();
    expect((await depositRow()).status).toBe('credited');
  });
});
