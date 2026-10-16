/**
 * Pre-flight checks the worker runs before touching the database. Kept free of
 * side effects so it can be unit tested; workers/index.ts exits on any error.
 */
import { REAL_FUNDS_REFUSAL, realFundsRequested } from '../src/server/phase-guard';

export function workerStartupError(env: NodeJS.ProcessEnv): string | null {
  if (realFundsRequested(env)) return `${REAL_FUNDS_REFUSAL} Refusing to start.`;
  if (!env.DATABASE_URL_WORKER) return 'DATABASE_URL_WORKER is required';
  return null;
}
