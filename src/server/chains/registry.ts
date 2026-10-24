/**
 * Network/token configuration lookups and adapter resolution. Networks without
 * an implemented adapter fail loudly instead of falling back to a fake.
 */
import { many, maybeOne, one, type Db } from '../db-core';
import { parseBase } from '@/lib/money';
import { REAL_FUNDS_NETWORKS, realFundsActive } from '../phase-guard';
import { EvmChainAdapter } from './evm';
import { SimulatedChainAdapter } from './simulated';
import type { ChainAdapter, NetworkConfig, TokenConfig } from './types';

export class AdapterNotAvailableError extends Error {
  override name = 'AdapterNotAvailableError';
}

interface NetworkRow {
  id: number;
  code: string;
  name: string;
  family: NetworkConfig['family'];
  chain_id: string | null;
  is_testnet: boolean;
  required_confirmations: number;
  status: NetworkConfig['status'];
  explorer_tx_url: string | null;
}

const toNetwork = (r: NetworkRow): NetworkConfig => ({
  id: Number(r.id),
  code: r.code,
  name: r.name,
  family: r.family,
  chainId: r.chain_id,
  isTestnet: r.is_testnet,
  requiredConfirmations: r.required_confirmations,
  status: r.status,
  explorerTxUrl: r.explorer_tx_url,
});

const NETWORK_COLS = 'id, code, name, family, chain_id::text, is_testnet, required_confirmations, status, explorer_tx_url';

export async function getNetwork(db: Db, idOrCode: number | string): Promise<NetworkConfig> {
  const col = typeof idOrCode === 'number' ? 'id' : 'code';
  return toNetwork(await one<NetworkRow>(db, `select ${NETWORK_COLS} from public.supported_networks where ${col} = $1`, [idOrCode]));
}

export async function listNetworks(db: Db, opts: { includeDisabled?: boolean } = {}): Promise<NetworkConfig[]> {
  const rows = await many<NetworkRow>(
    db,
    `select ${NETWORK_COLS} from public.supported_networks ${opts.includeDisabled ? '' : "where status <> 'disabled'"} order by id`,
  );
  return rows.map(toNetwork);
}

interface TokenRow {
  id: number;
  network_id: number;
  symbol: string;
  contract_address: string | null;
  decimals: number;
  is_native: boolean;
  is_test_token: boolean;
  status: TokenConfig['status'];
  min_deposit_base: string;
  min_withdrawal_base: string;
}

const toToken = (r: TokenRow): TokenConfig => ({
  id: Number(r.id),
  networkId: Number(r.network_id),
  symbol: r.symbol,
  contractAddress: r.contract_address,
  decimals: Number(r.decimals),
  isNative: r.is_native,
  isTestToken: r.is_test_token,
  status: r.status,
  minDepositBase: parseBase(r.min_deposit_base),
  minWithdrawalBase: parseBase(r.min_withdrawal_base),
});

const TOKEN_COLS =
  'id, network_id, symbol, contract_address, decimals, is_native, is_test_token, status, min_deposit_base::text, min_withdrawal_base::text';

export async function getToken(db: Db, tokenId: number): Promise<TokenConfig> {
  return toToken(await one<TokenRow>(db, `select ${TOKEN_COLS} from public.supported_tokens where id = $1`, [tokenId]));
}

export async function listNetworkTokens(db: Db, networkId: number): Promise<TokenConfig[]> {
  const rows = await many<TokenRow>(db, `select ${TOKEN_COLS} from public.supported_tokens where network_id = $1 order by id`, [networkId]);
  return rows.map(toToken);
}

/** The single depositable stablecoin for a network (non-native, active). */
export async function getDepositToken(db: Db, networkId: number): Promise<TokenConfig | null> {
  const row = await maybeOne<TokenRow>(
    db,
    `select ${TOKEN_COLS} from public.supported_tokens
      where network_id = $1 and not is_native and status = 'active' order by id limit 1`,
    [networkId],
  );
  return row ? toToken(row) : null;
}

export async function getNativeToken(db: Db, networkId: number): Promise<TokenConfig | null> {
  const row = await maybeOne<TokenRow>(db, `select ${TOKEN_COLS} from public.supported_tokens where network_id = $1 and is_native`, [networkId]);
  return row ? toToken(row) : null;
}

/** Allowlist lookup by exact contract address on a specific network. */
export async function findTokenByContract(db: Db, networkId: number, contract: string): Promise<TokenConfig | null> {
  const row = await maybeOne<TokenRow>(
    db,
    `select ${TOKEN_COLS} from public.supported_tokens where network_id = $1 and contract_address = $2`,
    [networkId, contract.toLowerCase()],
  );
  return row ? toToken(row) : null;
}

/** Explicit mapping from network code to RPC env var; no implicit public RPC defaults. */
export const RPC_ENV: Record<string, string> = {
  'evm-sepolia': 'RPC_URL_EVM_SEPOLIA',
  'evm-anvil': 'RPC_URL_EVM_ANVIL',
  'bsc-testnet': 'RPC_URL_BSC_TESTNET',
  'bsc-mainnet': 'RPC_URL_BSC_MAINNET',
};

export function getAdapter(network: NetworkConfig, db: Db, env: NodeJS.ProcessEnv = process.env): ChainAdapter {
  // A mainnet adapter exists only for allowlisted networks, and only while real
  // funds are switched on in their supported (watch-only group wallet) scope.
  if (!network.isTestnet && !(realFundsActive(env) && REAL_FUNDS_NETWORKS[network.code] === network.chainId)) {
    throw new AdapterNotAvailableError(`Mainnet adapters are disabled for ${network.code}`);
  }
  switch (network.family) {
    case 'simulated':
      return new SimulatedChainAdapter(network, db);
    case 'evm': {
      const envName = RPC_ENV[network.code];
      const url = envName ? env[envName] : undefined;
      if (!url) throw new AdapterNotAvailableError(`No RPC configured for ${network.code} (set ${envName ?? 'an RPC env var'})`);
      return EvmChainAdapter.fromRpcUrl(network, url);
    }
    case 'tron':
      // Not implemented: needs a TronWeb/TronGrid integration, base58check
      // address validation and TRON finality rules. See docs/production-readiness.md.
      throw new AdapterNotAvailableError(`TRON adapter not implemented (${network.code})`);
  }
}

export function explorerUrl(network: NetworkConfig, txHash: string): string | null {
  if (!network.explorerTxUrl || txHash.startsWith('sim:')) return null;
  return network.explorerTxUrl.replace('{hash}', txHash);
}
