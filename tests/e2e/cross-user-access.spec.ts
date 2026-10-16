/**
 * Explicit attempts by one signed-in customer to read or act on another
 * customer's data, and to use staff endpoints, through the real HTTP API.
 */
import { expect, test } from '@playwright/test';
import type pg from 'pg';
import { adminDb, cleanupE2eUsers, createConfirmedUser, login } from './helpers';

let db: pg.Pool;
let victim: { id: string; email: string };
let attacker: { id: string; email: string };
let victimWithdrawalId: string;
let victimOrderId: string;

test.beforeAll(async () => {
  db = adminDb();
  await cleanupE2eUsers(db);
  victim = await createConfirmedUser(db, { kyc: true });
  attacker = await createConfirmedUser(db, { kyc: true });
  // Victim fixtures written directly (local DB): a pending withdrawal and a pending order.
  const ids = (
    await db.query(
      "select n.id as network_id, t.id as token_id, p.id as pool_id from public.supported_networks n join public.supported_tokens t on t.network_id = n.id and not t.is_native join public.investment_pools p on p.token_id = t.id where n.code = 'sim-evm'",
    )
  ).rows[0];
  victimWithdrawalId = (
    await db.query(
      `insert into public.withdrawal_requests (user_id, network_id, token_id, destination_address, amount_base, fee_base, net_amount_base, status, idempotency_key)
       values ($1, $2, $3, '0x2222222222222222222222222222222222222222', 20000000, 1000000, 19000000, 'pending_verification', $4) returning id`,
      [victim.id, ids.network_id, ids.token_id, `${victim.id}:e2e-victim-withdrawal`],
    )
  ).rows[0].id;
  victimOrderId = (
    await db.query("insert into public.investment_orders (pool_id, user_id, kind, amount_base, idempotency_key) values ($1, $2, 'subscription', 1000000, $3) returning id", [
      ids.pool_id,
      victim.id,
      `${victim.id}:e2e-victim-order`,
    ])
  ).rows[0].id;
  await db.query("insert into public.notification_events (user_id, kind, channel, payload) values ($1, 'e2e_private', 'in_app', '{\"secret\":\"victim-only\"}')", [victim.id]);
});

test.afterAll(async () => {
  await cleanupE2eUsers(db);
  await db.end();
});

test('a customer cannot see or act on another customer\'s records', async ({ page, baseURL }) => {
  await login(page, attacker.email);
  const api = page.request;
  const headers = { origin: baseURL!, 'content-type': 'application/json' };

  const me = await (await api.get('/api/me')).json();
  expect(me.id).toBe(attacker.id);

  // Reads return only the caller's own rows.
  const withdrawals = await (await api.get('/api/withdrawals')).json();
  expect(withdrawals.items.map((w: { id: string }) => w.id)).not.toContain(victimWithdrawalId);
  const investments = await (await api.get('/api/investments')).json();
  expect(JSON.stringify(investments)).not.toContain(victimOrderId);
  const notifications = await (await api.get('/api/notifications')).json();
  expect(JSON.stringify(notifications)).not.toContain('victim-only');
  const dashboard = await (await api.get('/api/dashboard')).text();
  expect(dashboard).not.toContain(victim.id);

  // Writes against the victim's ids are refused as "not found" (no existence oracle) and change nothing.
  const confirm = await api.post('/api/withdrawals/confirm', { headers, data: { withdrawalId: victimWithdrawalId } });
  expect(confirm.status()).toBe(422);
  expect((await confirm.json()).code).toBe('not_found');
  const cancel = await api.post(`/api/withdrawals/${victimWithdrawalId}/cancel`, { headers });
  expect((await cancel.json()).code).toBe('not_found');
  const cancelOrder = await api.post(`/api/investments/orders/${victimOrderId}/cancel`, { headers });
  expect((await cancelOrder.json()).code).toBe('not_found');

  const state = await db.query('select (select status::text from public.withdrawal_requests where id = $1) as w, (select status::text from public.investment_orders where id = $2) as o', [victimWithdrawalId, victimOrderId]);
  expect(state.rows[0]).toEqual({ w: 'pending_verification', o: 'pending' });
});

test('a customer without a staff role cannot use staff endpoints', async ({ page, baseURL }) => {
  await login(page, attacker.email);
  const api = page.request;
  const headers = { origin: baseURL!, 'content-type': 'application/json' };
  for (const path of ['/api/admin/overview', '/api/admin/users', '/api/admin/withdrawals', '/api/admin/reconciliation/export']) {
    const res = await api.get(path);
    expect(res.status(), path).toBe(403);
  }
  expect((await api.post(`/api/admin/users/${victim.id}/status`, { headers, data: { status: 'frozen', reason: 'attacker trying to freeze' } })).status()).toBe(403);
  expect((await api.post('/api/admin/controls', { headers, data: { key: 'withdrawals_paused', enabled: true, reason: 'attacker pausing payouts' } })).status()).toBe(403);
  expect((await api.post(`/api/admin/withdrawals/${victimWithdrawalId}/review`, { headers, data: { decision: 'approve', note: 'self-approval attempt' } })).status()).toBe(403);
  const status = await db.query('select account_status::text as s from public.user_profiles where user_id = $1', [victim.id]);
  expect(status.rows[0].s).toBe('active');

  // The admin console redirects non-staff away.
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/dashboard/);
});

test('a staff role without an MFA-verified session is still refused', async ({ page }) => {
  await db.query("insert into public.staff_roles (user_id, role) values ($1, 'admin') on conflict do nothing", [attacker.id]);
  try {
    await login(page, attacker.email);
    const res = await page.request.get('/api/admin/overview');
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe('staff_mfa_required');
  } finally {
    await db.query('delete from public.staff_roles where user_id = $1', [attacker.id]);
  }
});
