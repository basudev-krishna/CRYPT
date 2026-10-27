import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { admin, balanceOf, closePools, createUser, mineBlocks, resetAppData, simAdapter, simDeposit, simNetwork, simToken, usdt, web, worker } from '../helpers/db';
import { creditDeposit, getDepositInstructions, ingestNetwork, refreshDeposit } from '../../src/server/deposits/service';
import { registerMemberWallet, removeMemberWallet, walletProofMessage } from '../../src/server/deposits/member-wallets';
import { SimulatedCustodyProvider } from '../../src/server/custody/simulated';
import { SimulatedChainAdapter } from '../../src/server/chains/simulated';
import { one, withTransaction } from '../../src/server/db-core';
import { checkIntegrity } from '../../src/server/ledger/ledger';

const actor = { type: 'service' as const, id: 'test' };
const GROUP = '0x0000000000000000000000000000000000000a07'; // the seeded simulated hot wallet
let tokenId: number;

beforeEach(async () => {
  await resetAppData();
  tokenId = (await simToken()).id;
  await admin.query('update public.treasury_wallets set receives_deposits = true where address = $1', [GROUP]);
});
afterAll(closePools);

/** Register `account` as `userId`'s sending wallet through the web role, with a real signature. */
async function register(userId: string, account: PrivateKeyAccount) {
  const net = await simNetwork();
  const issuedAt = new Date().toISOString();
  const signature = await account.signMessage({ message: walletProofMessage({ userId, networkCode: net.code, address: account.address, issuedAt }) });
  return withTransaction(web, (db) => registerMemberWallet(db, { userId, networkId: net.id, address: account.address, issuedAt, signature, actor }));
}

async function tick() {
  const adapter = await simAdapter();
  await ingestNetwork(worker, adapter);
  const ids = (await worker.query("select id from public.deposits where status in ('detected', 'confirming', 'confirmed')")).rows.map((r) => r.id as string);
  for (const id of ids) {
    await withTransaction(worker, (db) => refreshDeposit(db, new SimulatedChainAdapter(adapter.network, db), id));
    await withTransaction(worker, (db) => creditDeposit(db, id));
  }
}

/** Everything credited to a member, whether still cash or auto-subscribed. */
const memberFunds = async (userId: string) => (await balanceOf('user_cash', tokenId, userId)) + (await balanceOf('user_pending_subscription', tokenId, userId));

const deposit = () => one<{ id: string; user_id: string | null; status: string; status_reason: string | null; member_wallet_id: string | null }>(admin, 'select id, user_id, status, status_reason, member_wallet_id from public.deposits');

describe('group wallet deposits', () => {
  it('reveals the shared group wallet only after the member registers a sending wallet, without calling custody', async () => {
    const user = await createUser();
    const net = await simNetwork();
    const instructions = () => getDepositInstructions(worker, new SimulatedCustodyProvider(worker), user, net.id, actor);
    expect(await instructions()).toMatchObject({ mode: 'group_wallet', address: null });

    await register(user, privateKeyToAccount(generatePrivateKey()));
    expect(await instructions()).toMatchObject({ mode: 'group_wallet', address: GROUP });
    expect((await admin.query('select count(*)::int as n from public.deposit_addresses')).rows[0].n).toBe(0);
  });

  it('withholds the address again once the member removes their only wallet', async () => {
    const user = await createUser();
    const net = await simNetwork();
    const wallet = await register(user, privateKeyToAccount(generatePrivateKey()));
    await withTransaction(web, (db) => removeMemberWallet(db, { userId: user, walletId: wallet.id, actor }));
    expect(await getDepositInstructions(worker, new SimulatedCustodyProvider(worker), user, net.id, actor)).toMatchObject({ address: null });
  });

  it('credits a deposit from a registered wallet to its owner, exactly once', async () => {
    const alice = await createUser();
    const bob = await createUser();
    const wallet = privateKeyToAccount(generatePrivateKey());
    await register(alice, wallet);

    await simDeposit(GROUP, usdt('250'), 5, { from: wallet.address.toLowerCase() });
    await tick();
    await tick();
    expect(await deposit()).toMatchObject({ user_id: alice, status: 'credited' });
    expect(await memberFunds(alice)).toBe(usdt('250'));
    expect(await memberFunds(bob)).toBe(0n);
    expect(await balanceOf('treasury_hot', tokenId)).toBe(usdt('250'));
    expect(await checkIntegrity(admin)).toEqual({ unbalancedTokens: [], cacheMismatches: [] });
  });

  it('books a deposit from an unknown sender into suspense and holds it for an admin', async () => {
    const alice = await createUser();
    await simDeposit(GROUP, usdt('400'), 5, { from: '0x2222222222222222222222222222222222222222' });
    await tick();
    const d = await deposit();
    expect(d).toMatchObject({ user_id: null, status: 'under_review', status_reason: 'unattributed' });
    // The funds are in the wallet, so the ledger shows them, but nobody's balance does.
    expect(await balanceOf('treasury_hot', tokenId)).toBe(usdt('400'));
    expect(await balanceOf('suspense_deposits', tokenId)).toBe(usdt('400'));
    expect(await memberFunds(alice)).toBe(0n);
    expect((await admin.query("select count(*)::int as n from public.risk_events where kind = 'deposit_unattributed'")).rows[0].n).toBe(1);
    expect(await checkIntegrity(admin)).toEqual({ unbalancedTokens: [], cacheMismatches: [] });
  });

  it('attributes a deposit whose sender registers before it is confirmed', async () => {
    const alice = await createUser();
    const wallet = privateKeyToAccount(generatePrivateKey());
    await simDeposit(GROUP, usdt('100'), 1, { from: wallet.address.toLowerCase() }); // network requires 3
    await tick();
    expect(await deposit()).toMatchObject({ user_id: null, status: 'confirming' });

    await register(alice, wallet);
    await mineBlocks(5);
    await tick();
    expect(await deposit()).toMatchObject({ user_id: alice, status: 'credited' });
    expect(await memberFunds(alice)).toBe(usdt('100'));
  });

  it('refuses to register a wallet already registered to another member', async () => {
    const alice = await createUser();
    const bob = await createUser();
    const wallet = privateKeyToAccount(generatePrivateKey());
    await register(alice, wallet);
    await expect(register(bob, wallet)).rejects.toMatchObject({ code: 'wallet_taken' });
    // Registering again as the owner is a no-op.
    await register(alice, wallet);
    expect((await admin.query('select count(*)::int as n from public.member_wallets')).rows[0].n).toBe(1);
  });

  it('refuses a proof signed by a different wallet', async () => {
    const alice = await createUser();
    const net = await simNetwork();
    const wallet = privateKeyToAccount(generatePrivateKey());
    const impostor = privateKeyToAccount(generatePrivateKey());
    const issuedAt = new Date().toISOString();
    const signature = await impostor.signMessage({ message: walletProofMessage({ userId: alice, networkCode: net.code, address: wallet.address, issuedAt }) });
    await expect(
      withTransaction(web, (db) => registerMemberWallet(db, { userId: alice, networkId: net.id, address: wallet.address, issuedAt, signature, actor })),
    ).rejects.toMatchObject({ code: 'wallet_proof_bad_signature' });
  });

  it('stops attributing after removal, and a removed wallet cannot be revived in place', async () => {
    const alice = await createUser();
    const wallet = privateKeyToAccount(generatePrivateKey());
    const w = await register(alice, wallet);
    await withTransaction(web, (db) => removeMemberWallet(db, { userId: alice, walletId: w.id, actor }));
    await expect(web.query("update public.member_wallets set status = 'active', removed_at = null where id = $1", [w.id])).rejects.toThrow(/can only be removed/);

    await simDeposit(GROUP, usdt('60'), 5, { from: wallet.address.toLowerCase() });
    await tick();
    expect(await deposit()).toMatchObject({ user_id: null, status: 'under_review', status_reason: 'unattributed' });
  });

  it('ignores transfers into the group wallet from platform wallets', async () => {
    const user = await createUser();
    const net = await simNetwork();
    await admin.query(
      "insert into public.deposit_addresses (user_id, network_id, address, custody_provider) values ($1, $2, '0x3333333333333333333333333333333333333333', 'simulated')",
      [user, net.id],
    );
    await simDeposit(GROUP, usdt('75'), 5, { from: '0x3333333333333333333333333333333333333333' });
    await tick();
    expect((await admin.query('select count(*)::int as n from public.deposits')).rows[0].n).toBe(0);
  });
});
