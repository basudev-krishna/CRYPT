/**
 * SIMULATED custody provider. Works only with the simulated network: it writes
 * transfers to public.sim_chain_transfers instead of signing anything. No keys
 * exist anywhere. Used for development, demos and automated tests.
 *
 * Test hooks: a destination address ending in "dead" produces a reverted
 * transfer, so failure handling can be exercised end to end.
 */
import { createHash } from 'node:crypto';
import { maybeOne, one, type Db } from '../db-core';
import { parseBase } from '@/lib/money';
import type { CustodyProvider, DepositAddressResult, TransferRequest, TransferResult } from './types';
import { CustodyUnavailableError } from './types';

const SIM_GAS_FEE_WEI = 21_000n * 1_000_000_000n; // 21k gas at 1 gwei, in sETH base units

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export class SimulatedCustodyProvider implements CustodyProvider {
  readonly name = 'simulated';
  readonly isSimulated = true;

  constructor(private readonly db: Db) {}

  supportsNetwork(networkCode: string): boolean {
    return networkCode === 'sim-evm';
  }

  private assertNetwork(code: string): void {
    if (!this.supportsNetwork(code)) {
      throw new CustodyUnavailableError(`Simulated custody cannot operate on ${code}; configure a real custody provider`);
    }
  }

  async createDepositAddress(args: { networkId: number; networkCode: string; userId: string }): Promise<DepositAddressResult> {
    this.assertNetwork(args.networkCode);
    // Deterministic per (network, user) so repeated calls are idempotent.
    const address = '0x' + sha256(`sim-deposit:${args.networkCode}:${args.userId}`).slice(0, 40);
    return { address, custodyRef: `sim-addr:${args.userId}` };
  }

  async submitTransfer(req: TransferRequest): Promise<TransferResult> {
    this.assertNetwork(req.networkCode);
    const txHash = 'sim:0x' + sha256(`sim-transfer:${req.idempotencyKey}`);
    const custodyTxId = `simc:${req.idempotencyKey}`;
    const success = !req.toAddress.toLowerCase().endsWith('dead');

    // Idempotent: the tx hash is derived from the key, and tx_hash is unique.
    await this.db.query(
      `insert into public.sim_chain_transfers (network_id, tx_hash, block_number, token_contract, from_address, to_address, amount_base, success)
       values ($1, $2, public.sim_block_number() + 1, $3, $4, $5, $6, $7)
       on conflict (tx_hash) do nothing`,
      [req.networkId, txHash, req.tokenContract.toLowerCase(), req.fromAddress.toLowerCase(), req.toAddress.toLowerCase(), req.amount.toString(), success],
    );
    const existing = await one<{ amount_base: string; to_address: string }>(
      this.db,
      'select amount_base::text, to_address from public.sim_chain_transfers where tx_hash = $1',
      [txHash],
    );
    if (parseBase(existing.amount_base) !== req.amount || existing.to_address !== req.toAddress.toLowerCase()) {
      throw new CustodyUnavailableError('Idempotency key reused with different transfer parameters');
    }
    return { custodyTxId, status: 'broadcast', txHash, feeNative: SIM_GAS_FEE_WEI };
  }

  async getTransfer(custodyTxId: string, networkId: number): Promise<TransferResult | null> {
    const key = custodyTxId.replace(/^simc:/, '');
    const txHash = 'sim:0x' + sha256(`sim-transfer:${key}`);
    const row = await maybeOne<{ block_number: string; success: boolean; head: string }>(
      this.db,
      `select block_number::text, success, public.sim_block_number()::text as head
         from public.sim_chain_transfers where network_id = $1 and tx_hash = $2`,
      [networkId, txHash],
    );
    if (!row) return null;
    const mined = BigInt(row.head) >= BigInt(row.block_number);
    const status = !mined ? 'broadcast' : row.success ? 'confirmed' : 'failed';
    return { custodyTxId, status, txHash, feeNative: SIM_GAS_FEE_WEI, ...(row.success ? {} : { error: 'execution reverted (simulated)' }) };
  }
}

export function getCustodyProvider(db: Db, env: NodeJS.ProcessEnv = process.env): CustodyProvider {
  const name = env.CUSTODY_PROVIDER ?? 'simulated';
  if (name === 'simulated') return new SimulatedCustodyProvider(db);
  // Real providers (e.g. Fireblocks, BitGo, Cobo, Liminal) are not integrated
  // yet. Refuse rather than silently falling back to the simulation.
  throw new CustodyUnavailableError(`Custody provider "${name}" is not integrated in this build`);
}
