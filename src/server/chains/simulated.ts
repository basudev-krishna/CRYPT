/**
 * SIMULATED chain adapter backed by public.sim_chain_transfers.
 * For local development and demos only - no real blockchain is involved and the
 * UI labels everything on this network as simulated.
 */
import { many, maybeOne, one, type Db } from '../db-core';
import { parseBase } from '@/lib/money';
import { confirmationsAt, type ChainAdapter, type NetworkConfig, type ObservedTransfer, type TxLookup } from './types';

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

interface SimRow {
  tx_hash: string;
  block_number: string;
  token_contract: string;
  from_address: string;
  to_address: string;
  amount_base: string;
  success: boolean;
}

export class SimulatedChainAdapter implements ChainAdapter {
  readonly isSimulated = true;
  constructor(readonly network: NetworkConfig, private readonly db: Db) {}

  isValidAddress(address: string): boolean {
    return EVM_ADDRESS.test(address);
  }

  normalizeAddress(address: string): string {
    if (!this.isValidAddress(address)) throw new Error('Invalid address');
    return address.toLowerCase();
  }

  async getBlockNumber(): Promise<bigint> {
    const r = await one<{ b: string }>(this.db, 'select public.sim_block_number()::text as b');
    return BigInt(r.b);
  }

  private toTransfer(r: SimRow): ObservedTransfer {
    return {
      txHash: r.tx_hash,
      logIndex: 0,
      blockNumber: BigInt(r.block_number),
      blockHash: `sim-block-${r.block_number}`,
      from: r.from_address,
      to: r.to_address,
      tokenContract: r.token_contract,
      amount: parseBase(r.amount_base),
    };
  }

  async scanTransfers(args: { tokenContract: string; recipients: string[]; fromBlock: bigint; toBlock: bigint }): Promise<ObservedTransfer[]> {
    if (args.recipients.length === 0) return [];
    const rows = await many<SimRow>(
      this.db,
      `select tx_hash, block_number::text, token_contract, from_address, to_address, amount_base::text, success
         from public.sim_chain_transfers
        where network_id = $1 and token_contract = $2 and to_address = any($3::text[])
          and block_number between $4 and $5 and success
        order by block_number, id`,
      [this.network.id, args.tokenContract.toLowerCase(), args.recipients, args.fromBlock.toString(), args.toBlock.toString()],
    );
    return rows.map((r) => this.toTransfer(r));
  }

  async lookupTransaction(txHash: string): Promise<TxLookup> {
    const r = await maybeOne<SimRow>(
      this.db,
      `select tx_hash, block_number::text, token_contract, from_address, to_address, amount_base::text, success
         from public.sim_chain_transfers where network_id = $1 and tx_hash = $2`,
      [this.network.id, txHash],
    );
    if (!r) return { status: 'not_found' };
    const head = await this.getBlockNumber();
    const blockNumber = BigInt(r.block_number);
    if (blockNumber > head) return { status: 'pending' };
    const confirmations = confirmationsAt(blockNumber, head);
    if (!r.success) return { status: 'failed', blockNumber, blockHash: `sim-block-${r.block_number}`, confirmations };
    return { status: 'success', blockNumber, blockHash: `sim-block-${r.block_number}`, confirmations, transfers: [this.toTransfer(r)] };
  }

  /** The simulated token has no contract to query; its decimals are the configured ones by definition. */
  async assertTokenDecimals(): Promise<void> {}

  async getTokenBalance(tokenContract: string, address: string): Promise<bigint> {
    const r = await one<{ b: string }>(
      this.db,
      `select (coalesce(sum(amount_base) filter (where to_address = $3), 0)
             - coalesce(sum(amount_base) filter (where from_address = $3), 0))::text as b
         from public.sim_chain_transfers
        where network_id = $1 and token_contract = $2 and success and block_number <= public.sim_block_number()`,
      [this.network.id, tokenContract.toLowerCase(), address.toLowerCase()],
    );
    return parseBase(r.b);
  }
}

/** Insert a simulated transfer (dev tooling and the simulated custody provider). */
export async function insertSimTransfer(
  db: Db,
  t: { networkId: number; tokenContract: string; from: string; to: string; amount: bigint; success?: boolean; delayBlocks?: number },
): Promise<{ txHash: string; blockNumber: bigint }> {
  const r = await one<{ tx_hash: string; block_number: string }>(
    db,
    `insert into public.sim_chain_transfers (network_id, tx_hash, block_number, token_contract, from_address, to_address, amount_base, success)
     values ($1, 'sim:0x' || encode(extensions.gen_random_bytes(32), 'hex'), public.sim_block_number() + $7, $2, $3, $4, $5, $6)
     returning tx_hash, block_number::text`,
    [t.networkId, t.tokenContract.toLowerCase(), t.from.toLowerCase(), t.to.toLowerCase(), t.amount.toString(), t.success ?? true, t.delayBlocks ?? 0],
  );
  return { txHash: r.tx_hash, blockNumber: BigInt(r.block_number) };
}
