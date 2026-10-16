/**
 * Real-funds phase guard, shared by the web server (env.ts) and the worker.
 * No 'server-only' import so the worker and Vitest can use it.
 *
 * Real-money operation is not implemented in this phase and must not be
 * switchable by configuration alone. Any value other than an explicit "off"
 * ("false", "0" or unset) is refused, so typos fail closed.
 */
const OFF_VALUES = new Set(['', 'false', '0']);

export function realFundsRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return !OFF_VALUES.has((env.REAL_FUNDS_ENABLED ?? '').trim().toLowerCase());
}

export const REAL_FUNDS_REFUSAL =
  'REAL_FUNDS_ENABLED is set but real funds are not supported in this build. Real custody, trading and withdrawals ' +
  'require the production-readiness checklist (docs/production-readiness.md) to be completed.';

export function assertRealFundsDisabled(env: NodeJS.ProcessEnv = process.env): void {
  if (realFundsRequested(env)) throw new Error(REAL_FUNDS_REFUSAL);
}

/** Demo tooling (simulated deposits) must never be reachable in production. */
export function assertDemoModeAllowed(env: NodeJS.ProcessEnv = process.env): void {
  const demo = ['true', '1'].includes((env.DEMO_MODE ?? '').trim().toLowerCase());
  if (demo && env.APP_ENV === 'production') throw new Error('DEMO_MODE cannot be enabled when APP_ENV=production');
}
