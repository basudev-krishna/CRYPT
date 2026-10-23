/**
 * Member sending wallets for group-wallet deposits.
 *
 * Deposits to the shared group wallet are attributed by sender, so a member may
 * only register an address they control: they sign a message naming their user
 * id, the network and the address. Without that proof anyone could register a
 * teammate's address first and receive the credit for their deposits.
 *
 * Only plain-key (EOA) signatures are accepted. Exchange withdrawals come from
 * the exchange's own wallets and cannot be registered; those deposits wait for
 * an admin allocation instead.
 */
import { many, maybeOne, one, type Db } from '../db-core';
import { getAccountStatus } from '../compliance/compliance';
import { recordAudit, type Actor } from '../ops';
import { getNetwork } from '../chains/registry';
import { DepositError } from './service';
import { checkWalletProof, walletProofMessage } from './wallet-proof';

export { walletProofMessage } from './wallet-proof';

export interface MemberWallet {
  id: string;
  networkId: number;
  address: string;
  createdAt: Date;
}

export async function listMemberWallets(db: Db, userId: string): Promise<MemberWallet[]> {
  const rows = await many<{ id: string; network_id: number; address: string; created_at: Date }>(
    db,
    "select id, network_id, address, created_at from public.member_wallets where user_id = $1 and status = 'active' order by created_at",
    [userId],
  );
  return rows.map((r) => ({ id: r.id, networkId: Number(r.network_id), address: r.address, createdAt: r.created_at }));
}

/** The network must be an active EVM network with a group wallet accepting deposits. */
async function groupNetwork(db: Db, networkId: number) {
  const network = await getNetwork(db, networkId);
  if (network.status !== 'active' || (network.family !== 'evm' && network.family !== 'simulated')) {
    throw new DepositError('This network is not accepting deposits', 'network_unavailable');
  }
  const wallet = await maybeOne<{ id: number }>(
    db,
    'select id from public.treasury_wallets where network_id = $1 and receives_deposits and is_active limit 1',
    [networkId],
  );
  if (!wallet) throw new DepositError('This network has no group wallet', 'group_wallet_unavailable');
  return network;
}

/** Register a sending wallet after verifying its signed proof. Re-registering one's own wallet is a no-op. */
export async function registerMemberWallet(
  db: Db,
  args: { userId: string; networkId: number; address: string; issuedAt: string; signature: string; actor: Actor; now?: Date },
): Promise<MemberWallet> {
  if ((await getAccountStatus(db, args.userId)) !== 'active') throw new DepositError('Your account is not permitted to deposit', 'account_restricted');
  const network = await groupNetwork(db, args.networkId);

  const proof = { userId: args.userId, networkCode: network.code, address: args.address, issuedAt: args.issuedAt, signature: args.signature };
  const check = await checkWalletProof(proof, args.now);
  if (!check.ok) {
    const messages = {
      invalid_address: 'That is not a valid wallet address',
      bad_timestamp: 'The signed message is malformed; request a new one',
      expired: 'The signed message has expired; request a new one and sign it again',
      bad_signature: 'The signature does not match this wallet. Sign the exact message with the wallet you are registering',
    } as const;
    throw new DepositError(messages[check.reason], `wallet_proof_${check.reason}`);
  }
  const address = check.address;

  const platform = await maybeOne<{ x: number }>(
    db,
    `select 1 as x from public.treasury_wallets where network_id = $1 and address = $2
     union all select 1 from public.deposit_addresses where network_id = $1 and address = $2 limit 1`,
    [network.id, address],
  );
  if (platform) throw new DepositError('Platform wallets cannot be registered', 'wallet_is_platform');

  const inserted = await maybeOne<{ id: string }>(
    db,
    `insert into public.member_wallets (user_id, network_id, address, proof_message, proof_signature)
     values ($1, $2, $3, $4, $5) on conflict (network_id, address) where status = 'active' do nothing returning id`,
    [args.userId, network.id, address, walletProofMessage(proof), args.signature],
  );
  const row = await one<{ id: string; user_id: string; network_id: number; address: string; created_at: Date }>(
    db,
    "select id, user_id, network_id, address, created_at from public.member_wallets where network_id = $1 and address = $2 and status = 'active'",
    [network.id, address],
  );
  // Only one member can own an address. A valid signature from another account
  // means the key is shared; refuse rather than guess whose deposits these are.
  if (row.user_id !== args.userId) throw new DepositError('This wallet is registered to another member', 'wallet_taken');
  if (inserted) await recordAudit(db, args.actor, 'deposit.wallet_registered', { type: 'member_wallet', id: row.id }, { networkId: network.id, address });
  return { id: row.id, networkId: Number(row.network_id), address: row.address, createdAt: row.created_at };
}

/** Stop attributing future deposits from this wallet. Past deposits keep their attribution. */
export async function removeMemberWallet(db: Db, args: { userId: string; walletId: string; actor: Actor }): Promise<void> {
  const res = await db.query(
    "update public.member_wallets set status = 'removed', removed_at = now() where id = $1 and user_id = $2 and status = 'active'",
    [args.walletId, args.userId],
  );
  if (res.rowCount !== 1) throw new DepositError('Wallet not found', 'not_found');
  await recordAudit(db, args.actor, 'deposit.wallet_removed', { type: 'member_wallet', id: args.walletId });
}
