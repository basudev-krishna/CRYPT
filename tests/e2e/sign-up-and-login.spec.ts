/** Open sign-up with email verification (no admin approval), then sign-in. */
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type pg from 'pg';
import { adminDb, cleanupE2eUsers, createConfirmedUser, login, PASSWORD } from './helpers';

let db: pg.Pool;
/** The referral id is required: sign-ups without a ?ref link use this member's. */
let sponsorCode: string;

test.beforeAll(async () => {
  db = adminDb();
  await cleanupE2eUsers(db);
  const s = await createConfirmedUser(db);
  sponsorCode = (await db.query('select member_code from public.user_profiles where user_id = $1', [s.id])).rows[0].member_code as string;
});

test.afterAll(async () => {
  await cleanupE2eUsers(db);
  await db.end();
});

/** Fills the register form; the username is the email's local part. A pre-filled referral id is kept. */
async function fillRegister(page: import('@playwright/test').Page, email: string, side: 'left' | 'right' = 'right') {
  const referral = page.getByLabel('Referral id');
  if (!(await referral.inputValue())) await referral.fill(sponsorCode);
  await page.getByRole('radio', { name: new RegExp(`${side} team`, 'i') }).click();
  await page.getByLabel('Full name').fill('E2E Applicant');
  await page.getByLabel('Username').fill(`u_${email.split('@')[0]}`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Country').selectOption('IN');
  await page.getByLabel('Mobile number').fill('98765 43210');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
}

test('a referral link pre-fills the referral id and links the new member to the referrer', async ({ page }) => {
  const sponsor = await createConfirmedUser(db);
  const code = (await db.query('select member_code from public.user_profiles where user_id = $1', [sponsor.id])).rows[0].member_code as string;

  // The sponsor's Referrals page shows a link to this site with their id.
  await login(page, sponsor.email);
  await page.goto('/referrals');
  const link = `${new URL(page.url()).origin}/register?ref=${code}`;
  await expect(page.getByText(link)).toBeVisible();
  await page.context().clearCookies();

  // An unknown id is refused before any account is created.
  const stranger = `${randomUUID().slice(0, 8)}@e2e.test.local`;
  await page.goto('/register?ref=EW-999999');
  await fillRegister(page, stranger);
  await expect(page.getByRole('alert').filter({ hasText: 'That referral id was not found.' }).first()).toBeVisible();
  expect((await db.query('select 1 from auth.users where email = $1', [stranger])).rowCount).toBe(0);

  // Following the real link: the id is pre-filled, and the new profile is permanently linked to the sponsor.
  const email = `${randomUUID().slice(0, 8)}@e2e.test.local`;
  await page.goto(link);
  await expect(page.getByLabel('Referral id')).toHaveValue(code);
  await expect(page.getByText('Choose Your Team Position')).toBeVisible();
  await fillRegister(page, email, 'left');
  // "Check your inbox" when email confirmation is on, the dashboard when it is off: either way the account exists.
  await expect(page.getByText('Check your inbox').or(page.getByRole('heading', { name: 'Your account', exact: true }))).toBeVisible({ timeout: 30_000 });
  const row = await db.query('select p.sponsor_user_id from public.user_profiles p join auth.users u on u.id = p.user_id where u.email = $1', [email]);
  expect(row.rows[0]?.sponsor_user_id).toBe(sponsor.id);
  // The chosen side was placed with the account.
  const placed = await db.query('select b.parent_user_id, b.side from public.binary_placements b join auth.users u on u.id = b.user_id where u.email = $1', [email]);
  expect(placed.rows[0]).toEqual({ parent_user_id: sponsor.id, side: 'left' });
});

test('sign-up needs email verification, and no admin approval, before the app opens', async ({ page }) => {
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

  // Once verified, the account is active and the app opens straight away.
  await db.query('update auth.users set email_confirmed_at = now() where email = $1', [email]);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
  expect((await db.query('select account_status::text as s from public.user_profiles where email = $1', [email])).rows[0]?.s).toBe('active');
  await page.goto('/settings');
  await expect(page.getByText(/^EW-\d{6}$/)).toBeVisible();
});

test('new members can sign in with their username', async ({ page }) => {
  const email = `${randomUUID().slice(0, 8)}@e2e.test.local`;
  await page.goto('/register');
  await fillRegister(page, email);
  await expect(page.getByText('Check your inbox')).toBeVisible({ timeout: 30_000 });
  await db.query('update auth.users set email_confirmed_at = now() where email = $1', [email]);
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
