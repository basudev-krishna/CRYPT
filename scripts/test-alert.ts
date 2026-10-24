/**
 * Sends one test message through every configured alert channel (email and/or
 * Telegram), reading .env.local like the worker does.
 *
 *   npm run alert:test
 */
import { config } from 'dotenv';
import { alertChannels } from '../src/server/alerts';

config({ path: ['.env.local', '.env'], quiet: true });

async function main() {
  const channels = alertChannels(process.env);
  if (channels.length === 0) {
    throw new Error('No alert channel configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, ALERT_EMAIL_FROM and ALERT_EMAIL_TO in .env.local');
  }
  const text = ['✅ TEST · alert channel check', `Sent ${new Date().toISOString()} from APP_ENV=${process.env.APP_ENV ?? 'development'}.`, 'If you can read this, alerts reach you.'].join('\n');
  let failed = 0;
  for (const ch of channels) {
    const name = ch.constructor.name.replace('Sender', '');
    try {
      await ch.send(text);
      console.log(`${name}: sent`);
    } catch (err) {
      failed++;
      console.log(`${name}: FAILED - ${(err as Error).message}`);
    }
  }
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
