import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { AdapterNotAvailableError, getAdapter } from '@/server/chains/registry';
import type { NetworkConfig } from '@/server/chains/types';
import type { Db } from '@/server/db-core';
import { MAINNET_LIMITS, scaledLimits, tokenMinimums } from '@/server/group-limits';
import { assertDemoModeAllowed, assertRealFundsDisabled, assertRealFundsScope, realFundsActive, realFundsRefusal, realFundsRequested } from '@/server/phase-guard';
import { workerStartupError } from '../../workers/startup-guard';

const env = (o: Record<string, string | undefined>) => o as unknown as NodeJS.ProcessEnv;
const base = { DATABASE_URL_WORKER: 'postgres://u:p@127.0.0.1:1/x' };
/** The one supported real-funds configuration. */
const live = {
  REAL_FUNDS_ENABLED: 'true',
  APP_ENV: 'production',
  GROUP_MODE: 'true',
  CUSTODY_PROVIDER: 'manual',
  DEMO_MODE: 'false',
  RPC_URL_BSC_MAINNET: 'https://bsc.example.invalid',
};

describe('real-funds phase guard', () => {
  it('treats only unset, "false" and "0" as off', () => {
    for (const v of [undefined, '', 'false', '0', ' FALSE ']) expect(realFundsRequested(env({ REAL_FUNDS_ENABLED: v }))).toBe(false);
    for (const v of ['true', '1', 'TRUE', 'yes', 'on', 'enabled']) expect(realFundsRequested(env({ REAL_FUNDS_ENABLED: v }))).toBe(true);
  });

  it('allows real funds only in private group mode with manual custody on production', () => {
    expect(realFundsRefusal(env(live))).toBeNull();
    expect(realFundsActive(env(live))).toBe(true);
    expect(() => assertRealFundsScope(env(live))).not.toThrow();
    expect(realFundsActive(env({ ...live, REAL_FUNDS_ENABLED: 'false' }))).toBe(false);
  });

  it('refuses every other real-funds configuration', () => {
    const broken: Record<string, string | undefined>[] = [
      { REAL_FUNDS_ENABLED: '1' },
      { REAL_FUNDS_ENABLED: 'yes' },
      { APP_ENV: 'staging' },
      { APP_ENV: undefined },
      { GROUP_MODE: 'false' },
      { GROUP_MODE: undefined },
      { CUSTODY_PROVIDER: 'simulated' },
      { CUSTODY_PROVIDER: undefined },
      { DEMO_MODE: 'true' },
      { RPC_URL_BSC_MAINNET: ' ' },
    ];
    for (const patch of broken) {
      const e = env({ ...live, ...patch });
      expect(realFundsRefusal(e), JSON.stringify(patch)).toMatch(/not supported/);
      expect(realFundsActive(e)).toBe(false);
      expect(() => assertRealFundsScope(e)).toThrow(/not supported/);
    }
    expect(() => assertRealFundsScope(env({ REAL_FUNDS_ENABLED: 'false' }))).not.toThrow();
  });

  it('keeps demo tooling refused whenever real funds are requested', () => {
    expect(() => assertRealFundsDisabled(env(live))).toThrow();
    expect(() => assertRealFundsDisabled(env({ REAL_FUNDS_ENABLED: 'false' }))).not.toThrow();
  });

  it('refuses demo mode in production', () => {
    expect(() => assertDemoModeAllowed(env({ DEMO_MODE: 'true', APP_ENV: 'production' }))).toThrow();
    expect(() => assertDemoModeAllowed(env({ DEMO_MODE: 'true', APP_ENV: 'development' }))).not.toThrow();
  });

  it('blocks worker startup unless real funds are correctly scoped', () => {
    expect(workerStartupError(env({ ...base, REAL_FUNDS_ENABLED: 'true' }))).toMatch(/Refusing to start/);
    expect(workerStartupError(env({ ...base, REAL_FUNDS_ENABLED: '1' }))).toMatch(/Refusing to start/);
    expect(workerStartupError(env({ ...base, REAL_FUNDS_ENABLED: 'false' }))).toBeNull();
    expect(workerStartupError(env({ REAL_FUNDS_ENABLED: 'false' }))).toMatch(/DATABASE_URL_WORKER/);
    // Correctly scoped, but production still needs alerting.
    expect(workerStartupError(env({ ...base, ...live }))).toMatch(/alert channel is required/);
    expect(workerStartupError(env({ ...base, ...live, TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: 'c' }))).toBeNull();
  });

  it('the real worker process exits non-zero before connecting when real funds are requested out of scope', () => {
    for (const value of ['true', '1']) {
      const res = spawnSync(process.execPath, ['--import', 'tsx', 'workers/index.ts'], {
        env: { ...process.env, ...base, REAL_FUNDS_ENABLED: value, GROUP_MODE: 'false' },
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/Refusing to start/);
      expect(res.stdout).not.toMatch(/worker\.started/);
    }
  }, 120_000);
});

describe('mainnet adapters', () => {
  const db = {} as Db;
  const net = (o: Partial<NetworkConfig>): NetworkConfig => ({
    id: 1,
    code: 'bsc-mainnet',
    name: 'BNB Smart Chain',
    family: 'evm',
    chainId: '56',
    isTestnet: false,
    requiredConfirmations: 15,
    status: 'active',
    explorerTxUrl: null,
    ...o,
  });

  it('exist only for allowlisted networks while real funds are scoped', () => {
    expect(getAdapter(net({}), db, env(live)).network.code).toBe('bsc-mainnet');
    expect(() => getAdapter(net({}), db, env({ ...live, REAL_FUNDS_ENABLED: 'false' }))).toThrow(AdapterNotAvailableError);
    expect(() => getAdapter(net({}), db, env({ ...live, GROUP_MODE: 'false' }))).toThrow(AdapterNotAvailableError);
    expect(() => getAdapter(net({ code: 'eth-mainnet', chainId: '1' }), db, env(live))).toThrow(AdapterNotAvailableError);
    expect(() => getAdapter(net({ chainId: '1' }), db, env(live))).toThrow(AdapterNotAvailableError);
  });
});

describe('real-funds policy limits', () => {
  it('rewrites every amount in the token decimals', () => {
    const params = { fee_base: '1000000', max_per_tx_base: '10000000000', require_mfa: true, max_requests_per_hour: 3 };
    expect(scaledLimits('withdrawal', params, 18)).toEqual({
      fee_base: '0',
      max_per_tx_base: (BigInt(MAINNET_LIMITS.withdrawal!.max_per_tx_base!) * 10n ** 18n).toString(),
    });
    expect(scaledLimits('withdrawal', { hot_wallet_min_reserve_base: '5' }, 18)).toEqual({ hot_wallet_min_reserve_base: '0' });
  });

  it('sets a 50 USDT deposit minimum and no withdrawal minimum', () => {
    expect(tokenMinimums(18)).toEqual({ deposit: (50n * 10n ** 18n).toString(), withdrawal: '0' });
  });

  it('refuses an amount it has no value for instead of leaving it in the wrong decimals', () => {
    expect(() => scaledLimits('withdrawal', { surprise_base: '1' }, 18)).toThrow(/No mainnet value/);
    expect(() => scaledLimits('fee', { anything_base: '1' }, 18)).toThrow(/No mainnet value/);
  });
});
