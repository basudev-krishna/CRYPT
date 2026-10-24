/**
 * Real-funds phase guard, shared by the web server (env.ts) and the worker.
 * No 'server-only' import so the worker and Vitest can use it.
 *
 * Real money is supported in exactly one shape: private group mode on BNB Smart
 * Chain, where the app only watches the group wallet and the administrator
 * signs every payout (CUSTODY_PROVIDER=manual). The app never holds keys.
 * Anything else that asks for real funds is refused, and any value other than
 * an explicit "off" ("false", "0" or unset) counts as asking, so typos fail closed.
 */
const OFF_VALUES = new Set(['', 'false', '0']);
const ON_VALUES = new Set(['true', '1']);

const flag = (v: string | undefined) => (v ?? '').trim().toLowerCase();

/** Mainnets real funds may use: network code → chain id. Mirrors the mainnet_allowlist DB constraint. */
export const REAL_FUNDS_NETWORKS: Readonly<Record<string, string>> = { 'bsc-mainnet': '56' };

export function realFundsRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return !OFF_VALUES.has(flag(env.REAL_FUNDS_ENABLED));
}

export const REAL_FUNDS_REFUSAL =
  'REAL_FUNDS_ENABLED is set but this configuration is not supported. Real funds run only in private group mode on BNB Smart Chain ' +
  'with manual custody (see docs/production-readiness.md).';

/** Why real funds are refused for this environment, or null when they are off or correctly scoped. */
export function realFundsRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!realFundsRequested(env)) return null;
  const missing: string[] = [];
  if (flag(env.REAL_FUNDS_ENABLED) !== 'true') missing.push('REAL_FUNDS_ENABLED must be exactly "true"');
  if (env.APP_ENV !== 'production') missing.push('APP_ENV=production');
  if (!ON_VALUES.has(flag(env.GROUP_MODE))) missing.push('GROUP_MODE=true');
  if (env.CUSTODY_PROVIDER !== 'manual') missing.push('CUSTODY_PROVIDER=manual');
  if (ON_VALUES.has(flag(env.DEMO_MODE))) missing.push('DEMO_MODE=false');
  if (!env.RPC_URL_BSC_MAINNET?.trim()) missing.push('RPC_URL_BSC_MAINNET');
  return missing.length ? `${REAL_FUNDS_REFUSAL} Required: ${missing.join(', ')}.` : null;
}

export function assertRealFundsScope(env: NodeJS.ProcessEnv = process.env): void {
  const refusal = realFundsRefusal(env);
  if (refusal) throw new Error(refusal);
}

/** True only when real funds are requested and every scoping condition holds. */
export function realFundsActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return realFundsRequested(env) && realFundsRefusal(env) === null;
}

/** For tooling that must never touch real money (demo seeding). */
export function assertRealFundsDisabled(env: NodeJS.ProcessEnv = process.env): void {
  if (realFundsRequested(env)) throw new Error('REAL_FUNDS_ENABLED is set; this tool only runs against test environments.');
}

/** Demo tooling (simulated deposits) must never be reachable in production. */
export function assertDemoModeAllowed(env: NodeJS.ProcessEnv = process.env): void {
  const demo = ON_VALUES.has(flag(env.DEMO_MODE));
  if (demo && env.APP_ENV === 'production') throw new Error('DEMO_MODE cannot be enabled when APP_ENV=production');
}
