import 'server-only';
import { z } from 'zod';
import { assertDemoModeAllowed, assertRealFundsScope } from './phase-guard';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
  DATABASE_URL_WEB: z.string().startsWith('postgres'),
  INTERNAL_API_SECRET: z.string().min(32, 'INTERNAL_API_SECRET must be at least 32 characters'),
  DEMO_MODE: bool,
  /** Private-group operation: no investment pool; hides portfolio and trading pages. */
  GROUP_MODE: bool,
  REAL_FUNDS_ENABLED: bool,
  /**
   * 'queue' (default): background jobs go to the worker process via pg-boss.
   * 'inline': there is no worker; each job runs immediately inside the admin's
   * request with the worker's database role (DATABASE_URL_WORKER), and the
   * admin's "Sync & process now" runs what the worker's schedule would.
   */
  JOBS_MODE: z.enum(['queue', 'inline']).default('queue'),
  /**
   * Bearer token for /internal/cron/sync, the scheduled sync pass that replaces
   * the worker's schedule under JOBS_MODE=inline (Vercel Cron sends it itself).
   * Unset: the endpoint refuses every call.
   */
  CRON_SECRET: z.string().min(32, 'CRON_SECRET must be at least 32 characters').optional(),
});

export type ServerEnv = z.infer<typeof schema>;

let cached: ServerEnv | undefined;

export function serverEnv(): ServerEnv {
  if (cached) return cached;
  // Checked on the raw environment first, so a malformed value cannot slip past the guard.
  assertRealFundsScope(process.env);
  assertDemoModeAllowed(process.env);
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid server environment: ${z.prettifyError(parsed.error)}`);
  }
  cached = parsed.data;
  return cached;
}
