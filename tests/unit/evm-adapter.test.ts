import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Hash } from 'viem';
import { EvmChainAdapter, TRANSFER_EVENT, type EvmClient } from '../../src/server/chains/evm';
import { ChainUnavailableError, type NetworkConfig } from '../../src/server/chains/types';

const network: NetworkConfig = {
  id: 2,
  code: 'evm-sepolia',
  name: 'Sepolia',
  family: 'evm',
  chainId: '11155111',
  isTestnet: true,
  requiredConfirmations: 12,
  status: 'active',
  explorerTxUrl: null,
};
const TOKEN = '0x00000000000000000000000000000000000000aa';
const OTHER_TOKEN = '0x00000000000000000000000000000000000000bb';
const TO = '0x00000000000000000000000000000000000000cc';
const FROM = '0x00000000000000000000000000000000000000dd';
const HASH = ('0x' + '11'.repeat(32)) as Hash;

function transferLog(token: string, value: bigint, logIndex: number) {
  return {
    address: token,
    topics: encodeEventTopics({ abi: [TRANSFER_EVENT], eventName: 'Transfer', args: { from: FROM, to: TO } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
    logIndex,
  };
}

function fakeClient(opts: { chainId?: number; head?: bigint; receipt?: unknown; receiptMissing?: boolean; inMempool?: boolean; decimals?: number }): EvmClient {
  return {
    getChainId: async () => opts.chainId ?? 11155111,
    getBlockNumber: async () => opts.head ?? 120n,
    getTransactionReceipt: async () => {
      if (opts.receiptMissing) throw Object.assign(new Error('not found'), { name: 'TransactionReceiptNotFoundError' });
      return opts.receipt;
    },
    getTransaction: async () => {
      if (!opts.inMempool) throw new Error('unknown tx');
      return {};
    },
    getLogs: async () => [],
    readContract: async ({ functionName }: { functionName: string }) => (functionName === 'decimals' ? (opts.decimals ?? 6) : 0n),
  } as unknown as EvmClient;
}

describe('EVM adapter receipt verification', () => {
  it('decodes ERC-20 transfers and counts confirmations from the head', async () => {
    const receipt = { status: 'success', blockNumber: 100n, blockHash: '0xABC', logs: [transferLog(TOKEN, 50_000000n, 3), transferLog(OTHER_TOKEN, 1n, 4)] };
    const a = new EvmChainAdapter(network, fakeClient({ receipt, head: 111n }));
    const r = await a.lookupTransaction(HASH);
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.confirmations).toBe(12);
    expect(r.transfers).toHaveLength(2);
    expect(r.transfers[0]).toMatchObject({ tokenContract: TOKEN, to: TO, from: FROM, amount: 50_000000n, logIndex: 3 });
    // The contract is preserved so the caller can match it against the allowlist (never by symbol).
    expect(r.transfers[1]?.tokenContract).toBe(OTHER_TOKEN);
  });

  it('reports reverted transactions as failed', async () => {
    const a = new EvmChainAdapter(network, fakeClient({ receipt: { status: 'reverted', blockNumber: 100n, blockHash: '0x1', logs: [] } }));
    expect((await a.lookupTransaction(HASH)).status).toBe('failed');
  });

  it('distinguishes pending (mempool) from unknown transactions', async () => {
    expect((await new EvmChainAdapter(network, fakeClient({ receiptMissing: true, inMempool: true })).lookupTransaction(HASH)).status).toBe('pending');
    expect((await new EvmChainAdapter(network, fakeClient({ receiptMissing: true })).lookupTransaction(HASH)).status).toBe('not_found');
    expect((await new EvmChainAdapter(network, fakeClient({})).lookupTransaction('0x1234')).status).toBe('not_found');
  });

  it('refuses to operate against an RPC serving a different chain', async () => {
    const a = new EvmChainAdapter(network, fakeClient({ chainId: 1 }));
    await expect(a.getBlockNumber()).rejects.toThrow(ChainUnavailableError);
  });

  it('verifies the token contract reports the configured decimals', async () => {
    await expect(new EvmChainAdapter(network, fakeClient({ decimals: 6 })).assertTokenDecimals(TOKEN, 6)).resolves.toBeUndefined();
    await expect(new EvmChainAdapter(network, fakeClient({ decimals: 18 })).assertTokenDecimals(TOKEN, 6)).rejects.toThrow(ChainUnavailableError);
  });

  it('validates and normalizes addresses', () => {
    const a = new EvmChainAdapter(network, fakeClient({}));
    expect(a.isValidAddress('0x123')).toBe(false);
    expect(a.normalizeAddress('0x00000000000000000000000000000000000000CC')).toBe(TO);
  });
});
