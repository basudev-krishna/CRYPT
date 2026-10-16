/**
 * EVM adapter (Ethereum, BSC, Anvil, Sepolia) built on viem.
 * Verifies receipts, the token contract, the recipient, the amount and
 * successful execution; confirmations are computed from the current head.
 */
import {
  createPublicClient,
  decodeEventLog,
  erc20Abi,
  getAddress,
  http,
  isAddress,
  parseAbiItem,
  type Hash,
  type PublicClient,
} from 'viem';
import { ChainUnavailableError, confirmationsAt, type ChainAdapter, type NetworkConfig, type ObservedTransfer, type TxLookup } from './types';

export const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const MAX_BLOCK_RANGE = 2_000n;

/** Minimal surface of viem's PublicClient used here (lets tests inject a fake). */
export type EvmClient = Pick<PublicClient, 'getBlockNumber' | 'getLogs' | 'getTransactionReceipt' | 'getTransaction' | 'readContract' | 'getChainId'>;

export class EvmChainAdapter implements ChainAdapter {
  readonly isSimulated = false;
  private chainChecked = false;
  private readonly decimalsChecked = new Set<string>();

  constructor(
    readonly network: NetworkConfig,
    private readonly client: EvmClient,
  ) {}

  static fromRpcUrl(network: NetworkConfig, rpcUrl: string): EvmChainAdapter {
    const client = createPublicClient({ transport: http(rpcUrl, { timeout: 15_000, retryCount: 2 }) });
    return new EvmChainAdapter(network, client as unknown as EvmClient);
  }

  /** Refuse to operate if the RPC endpoint serves a different chain than configured. */
  private async assertChain(): Promise<void> {
    if (this.chainChecked) return;
    const id = await this.client.getChainId();
    if (String(id) !== this.network.chainId) {
      throw new ChainUnavailableError(`RPC chain id ${id} does not match configured ${this.network.chainId} for ${this.network.code}`);
    }
    this.chainChecked = true;
  }

  isValidAddress(address: string): boolean {
    return isAddress(address, { strict: false });
  }

  normalizeAddress(address: string): string {
    if (!this.isValidAddress(address)) throw new Error('Invalid EVM address');
    return getAddress(address).toLowerCase();
  }

  async getBlockNumber(): Promise<bigint> {
    await this.assertChain();
    return this.client.getBlockNumber();
  }

  async scanTransfers(args: { tokenContract: string; recipients: string[]; fromBlock: bigint; toBlock: bigint }): Promise<ObservedTransfer[]> {
    await this.assertChain();
    if (args.recipients.length === 0 || args.toBlock < args.fromBlock) return [];
    const recipients = args.recipients.map((r) => getAddress(r));
    const out: ObservedTransfer[] = [];
    for (let start = args.fromBlock; start <= args.toBlock; start += MAX_BLOCK_RANGE) {
      const rangeEnd = start + MAX_BLOCK_RANGE - 1n;
      const end = rangeEnd < args.toBlock ? rangeEnd : args.toBlock;
      const logs = await this.client.getLogs({
        address: getAddress(args.tokenContract),
        event: TRANSFER_EVENT,
        args: { to: recipients },
        fromBlock: start,
        toBlock: end,
      });
      for (const log of logs) {
        if (log.removed || log.transactionHash === null || log.logIndex === null || log.blockNumber === null) continue;
        out.push({
          txHash: log.transactionHash.toLowerCase(),
          logIndex: log.logIndex,
          blockNumber: log.blockNumber,
          blockHash: log.blockHash?.toLowerCase() ?? null,
          from: (log.args.from ?? '').toLowerCase(),
          to: (log.args.to ?? '').toLowerCase(),
          tokenContract: log.address.toLowerCase(),
          amount: log.args.value ?? 0n,
        });
      }
    }
    return out;
  }

  async lookupTransaction(txHash: string): Promise<TxLookup> {
    await this.assertChain();
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { status: 'not_found' };
    let receipt;
    try {
      receipt = await this.client.getTransactionReceipt({ hash: txHash as Hash });
    } catch (err) {
      if ((err as Error).name === 'TransactionReceiptNotFoundError') {
        // Distinguish a transaction still in the mempool from an unknown hash.
        try {
          await this.client.getTransaction({ hash: txHash as Hash });
          return { status: 'pending' };
        } catch {
          return { status: 'not_found' };
        }
      }
      throw new ChainUnavailableError((err as Error).message);
    }
    const head = await this.client.getBlockNumber();
    const confirmations = confirmationsAt(receipt.blockNumber, head);
    const blockHash = receipt.blockHash.toLowerCase();
    if (receipt.status !== 'success') {
      return { status: 'failed', blockNumber: receipt.blockNumber, blockHash, confirmations };
    }
    const transfers: ObservedTransfer[] = [];
    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({ abi: [TRANSFER_EVENT], data: log.data, topics: log.topics });
        transfers.push({
          txHash: txHash.toLowerCase(),
          logIndex: log.logIndex,
          blockNumber: receipt.blockNumber,
          blockHash,
          from: decoded.args.from.toLowerCase(),
          to: decoded.args.to.toLowerCase(),
          tokenContract: log.address.toLowerCase(),
          amount: decoded.args.value,
        });
      } catch {
        // Not an ERC-20 Transfer log.
      }
    }
    return { status: 'success', blockNumber: receipt.blockNumber, blockHash, confirmations, transfers };
  }

  async getTokenBalance(tokenContract: string, address: string): Promise<bigint> {
    await this.assertChain();
    return this.client.readContract({
      address: getAddress(tokenContract),
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [getAddress(address)],
    });
  }

  async assertTokenDecimals(tokenContract: string, expected: number): Promise<void> {
    const key = tokenContract.toLowerCase();
    if (this.decimalsChecked.has(key)) return;
    await this.assertChain();
    const onchain = await this.client.readContract({ address: getAddress(tokenContract), abi: erc20Abi, functionName: 'decimals' });
    if (Number(onchain) !== expected) {
      throw new ChainUnavailableError(`Token ${tokenContract} on ${this.network.code} reports ${onchain} decimals, configured ${expected}`);
    }
    this.decimalsChecked.add(key);
  }
}
