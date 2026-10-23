/** Open sign-up with email verification and admin approval, then sign-in. */
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type pg from 'pg';
import { adminDb, cleanupE2eUsers, PASSWORD } from './helpers';

let db: pg.Pool;

test.beforeAll(async () => {
  db = adminDb();
  await cleanupE2eUsers(db);
});

test.afterAll(async () => {
  await cleanupE2eUsers(db);
  await db.end();
});

/** Fills the register form; the username is the email's local part. */
async function fillRegister(page: import('@playwright/test').Page, email: string) {
  await page.getByLabel('Full name').fill('E2E Applicant');
  await page.getByLabel('Username').fill(`u_${email.split('@')[0]}`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Country').selectOption('IN');
  await page.getByLabel('Mobile number').fill('98765 43210');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password', { exact: true }).fill(PASSWORD);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Create account' }).click();
}

test('sign-up needs email verification, then admin approval, before the app opens', async ({ page }) => {
  const email = `${randomUUID().slice(0, 8)}@e2e.test.local`;
  await page.goto(`/register?email=${encodeURIComponent(email)}`);
  await expect(page.getByLabel('Email')).toHaveValue(email);
  await fillRegister(page, email);
  await expect(page.getByText('Check your inbox')).toBeVisible({ timeout: 30_000 });

  // Before verification, sign-in is refused.
  await page.goto('/login');
  await page.getByLabel('Username or email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Please verify your email address first.')).toBeVisible();

  // Verified but not yet approved: every app page sends the user to the waiting page.
  await db.query('update auth.users set email_confirmed_at = now() where email = $1', [email]);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/pending-approval/, { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Awaiting approval' })).toBeVisible();
  await page.goto('/deposit');
  await expect(page).toHaveURL(/\/pending-approval/);
  const api = await page.request.post('/api/profile', { data: { displayName: 'Too early', countryCode: null }, headers: { origin: new URL(page.url()).origin } });
  expect(api.status()).toBe(403);

  await db.query("update public.user_profiles set account_status = 'active', reviewed_at = now() where email = $1", [email]);
  await page.goto('/settings');
  await expect(page.getByText(/^EW-\d{6}$/)).toBeVisible();
});

test('approved members can sign in with their username', async ({ page }) => {
  const email = `${randomUUID().slice(0, 8)}@e2e.test.local`;
  await page.goto('/register');
  await fillRegister(page, email);
  await expect(page.getByText('Check your inbox')).toBeVisible({ timeout: 30_000 });
  await db.query('update auth.users set email_confirmed_at = now() where email = $1', [email]);
  await db.query("update public.user_profiles set account_status = 'active', reviewed_at = now() where email = $1", [email]);
  await page.goto('/login');
  await page.getByLabel('Username or email').fill(`U_${email.slice(0, 8).toUpperCase()}`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
});

test('a rejected sign-up sees the not-approved page', async ({ page }) => {
  const email = `${randomUUID().slice(0, 8)}@e2e.test.local`;
  await page.goto('/register');
  await fillRegister(page, email);
  await expect(page.getByText('Check your inbox')).toBeVisible({ timeout: 30_000 });
  await db.query('update auth.users set email_confirmed_at = now() where email = $1', [email]);
  await db.query("update public.user_profiles set account_status = 'rejected', restriction_reason = 'Unable to verify the applicant' where email = $1", [email]);
  await page.goto('/login');
  await page.getByLabel('Username or email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Registration not approved' })).toBeVisible({ timeout: 30_000 });
});

test('a wrong password shows an error instead of doing nothing', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Username or email').fill(`${randomUUID().slice(0, 8)}@e2e.test.local`);
  await page.getByLabel('Password', { exact: true }).fill('Wrong-Password-1234');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Invalid username/email or password.')).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});
