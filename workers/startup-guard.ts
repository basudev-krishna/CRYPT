/**
 * Pre-flight checks the worker runs before touching the database. Kept free of
 * side effects so it can be unit tested; workers/index.ts exits on any error.
 */
import { alertChannels } from '../src/server/alerts';
import { realFundsRefusal } from '../src/server/phase-guard';

export function workerStartupError(env: NodeJS.ProcessEnv): string | null {
  const refusal = realFundsRefusal(env);
  if (refusal) return `${refusal} Refusing to start.`;
  if (!env.DATABASE_URL_WORKER) return 'DATABASE_URL_WORKER is required';
  // Outside local development an automatic pause nobody hears about is not acceptable.
  if ((env.APP_ENV === 'staging' || env.APP_ENV === 'production') && alertChannels(env).length === 0) {
    return `An alert channel is required when APP_ENV=${env.APP_ENV}: set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, ALERT_EMAIL_FROM and ALERT_EMAIL_TO (or TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID)`;
  }
  return null;
}
