import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { expect, type Page } from '@playwright/test';

function localUrl(name: string): string {
  const url = process.env[name];
  if (!url) throw new Error(`${name} must be set for e2e tests (see .env.example)`);
  const host = new URL(url).hostname;
  if (!['127.0.0.1', 'localhost'].includes(host)) throw new Error(`Refusing to run e2e tests against non-local host ${host}`);
  return url;
}

export const adminDb = () => new pg.Pool({ connectionString: localUrl('DATABASE_URL_ADMIN'), max: 2 });

export const PASSWORD = 'E2e-Test-Password-1234';

/** Sign up through Supabase Auth (local), then confirm the email directly in the local DB. */
export async function createConfirmedUser(db: pg.Pool, opts: { kyc?: boolean } = {}): Promise<{ id: string; email: string }> {
  const supabase = createClient(localUrl('NEXT_PUBLIC_SUPABASE_URL'), process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const email = `${randomUUID().slice(0, 8)}@e2e.test.local`;
  const { data, error } = await supabase.auth.signUp({ email, password: PASSWORD });
  if (error || !data.user) throw new Error(`signUp failed: ${error?.message}`);
  await db.query('update auth.users set email_confirmed_at = now() where id = $1', [data.user.id]);
  if (opts.kyc) await db.query("insert into public.kyc_records (user_id, status, full_name, submitted_at) values ($1, 'approved', 'E2E User', now())", [data.user.id]);
  return { id: data.user.id, email };
}

export async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
}

export async function cleanupE2eUsers(db: pg.Pool) {
  // Rows referencing auth.users use ON DELETE RESTRICT; remove dependents first (local test data only).
  const ids = (await db.query("select id from auth.users where email like '%@e2e.test.local'")).rows.map((r) => r.id as string);
  if (!ids.length) return;
  for (const t of ['withdrawal_destinations', 'withdrawal_requests', 'investment_orders', 'investment_positions', 'kyc_records', 'notification_events', 'risk_events', 'deposit_addresses', 'staff_roles']) {
    await db.query(`delete from public.${t} where user_id = any($1::uuid[])`, [ids]);
  }
  await db.query('delete from public.user_profiles where user_id = any($1::uuid[])', [ids]);
  await db.query('delete from auth.users where id = any($1::uuid[])', [ids]);
}
