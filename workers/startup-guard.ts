/**
 * Pre-flight checks the worker runs before touching the database. Kept free of
 * side effects so it can be unit tested; workers/index.ts exits on any error.
 */
import { REAL_FUNDS_REFUSAL, realFundsRequested } from '../src/server/phase-guard';

export function workerStartupError(env: NodeJS.ProcessEnv): string | null {
  if (realFundsRequested(env)) return `${REAL_FUNDS_REFUSAL} Refusing to start.`;
  if (!env.DATABASE_URL_WORKER) return 'DATABASE_URL_WORKER is required';
  // Outside local development an automatic pause nobody hears about is not acceptable.
  if ((env.APP_ENV === 'staging' || env.APP_ENV === 'production') && !(env.TELEGRAM_BOT_TOKEN?.trim() && env.TELEGRAM_CHAT_ID?.trim())) {
    return `TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required when APP_ENV=${env.APP_ENV}`;
  }
  return null;
}
