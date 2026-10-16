/** Network-agnostic blockchain adapter contract. One implementation per chain family. */

export interface NetworkConfig {
  id: number;
  code: string;
  name: string;
  family: 'evm' | 'tron' | 'simulated';
  chainId: string | null;
  isTestnet: boolean;
  requiredConfirmations: number;
  status: 'active' | 'paused' | 'disabled';
  explorerTxUrl: string | null;
}

export interface TokenConfig {
  id: number;
  networkId: number;
  symbol: string;
  contractAddress: string | null;
  decimals: number;
  isNative: boolean;
  isTestToken: boolean;
  status: 'active' | 'paused' | 'disabled';
  minDepositBase: bigint;
  minWithdrawalBase: bigint;
}

/** A single token Transfer event as observed on chain. */
export interface ObservedTransfer {
  txHash: string;
  logIndex: number;
  blockNumber: bigint;
  blockHash: string | null;
  from: string;
  to: string;
  tokenContract: string;
  amount: bigint;
}

export type TxLookup =
  | { status: 'not_found' }
  | { status: 'pending' }
  | { status: 'failed'; blockNumber: bigint; blockHash: string | null; confirmations: number }
  | { status: 'success'; blockNumber: bigint; blockHash: string | null; confirmations: number; transfers: ObservedTransfer[] };

export interface ChainAdapter {
  readonly network: NetworkConfig;
  readonly isSimulated: boolean;
  isValidAddress(address: string): boolean;
  /** Canonical form used for storage and comparison. Throws on invalid input. */
  normalizeAddress(address: string): string;
  getBlockNumber(): Promise<bigint>;
  /** Token Transfer events of `tokenContract` to any of `recipients` in [fromBlock, toBlock]. */
  scanTransfers(args: { tokenContract: string; recipients: string[]; fromBlock: bigint; toBlock: bigint }): Promise<ObservedTransfer[]>;
  /** Re-read a transaction receipt, its token transfers and current confirmations. */
  lookupTransaction(txHash: string): Promise<TxLookup>;
  getTokenBalance(tokenContract: string, address: string): Promise<bigint>;
  /**
   * Throws ChainUnavailableError unless the contract reports exactly the
   * configured decimals. Amounts are only meaningful if both sides agree.
   */
  assertTokenDecimals(tokenContract: string, expected: number): Promise<void>;
}

export class ChainUnavailableError extends Error {
  override name = 'ChainUnavailableError';
}

export function confirmationsAt(blockNumber: bigint, head: bigint): number {
  if (head < blockNumber) return 0;
  return Number(head - blockNumber + 1n);
}
