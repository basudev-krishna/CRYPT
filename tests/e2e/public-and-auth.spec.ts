import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';

test.describe('public pages', () => {
  test('landing page states it is a testnet build with simulated trading', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText(/Testnet MVP/i)).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('auditable USDT investment ledger');
  });

  test('sends security headers', async ({ request }) => {
    const res = await request.get('/');
    expect(res.headers()['x-frame-options']).toBe('DENY');
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
    expect(res.headers()['x-powered-by']).toBeUndefined();
  });

  test('signed-out visitors are sent to login from customer and admin pages', async ({ page }) => {
    for (const path of ['/dashboard', '/withdraw', '/portfolio', '/admin', '/admin/treasury']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login/);
    }
  });
});

test.describe('API authentication', () => {
  const origin = { origin: 'http://127.0.0.1:3100' };

  test('customer endpoints require a session', async ({ request }) => {
    for (const path of ['/api/me', '/api/dashboard', '/api/deposits', '/api/withdrawals', '/api/transactions', '/api/investments', '/api/performance']) {
      const res = await request.get(path);
      expect(res.status(), path).toBe(401);
      expect((await res.json()).code).toBe('unauthenticated');
    }
  });

  test('admin endpoints require a session', async ({ request }) => {
    for (const path of ['/api/admin/overview', '/api/admin/users', '/api/admin/treasury', '/api/admin/audit-events']) {
      expect((await request.get(path)).status(), path).toBe(401);
    }
    expect((await request.post('/api/admin/controls', { headers: origin, data: { key: 'withdrawals_paused', enabled: false, reason: 'resume attempt by anon' } })).status()).toBe(401);
  });

  test('state-changing requests from another origin are rejected before anything else', async ({ request }) => {
    const res = await request.post('/api/withdrawals', { headers: { origin: 'https://evil.example' }, data: {} });
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe('csrf');
    const noOrigin = await request.post('/api/withdrawals/confirm', { data: {} });
    expect(noOrigin.status()).toBe(403);
  });

  test('errors do not leak internals', async ({ request }) => {
    const res = await request.post('/api/withdrawals', { headers: origin, data: 'not json' });
    const text = await res.text();
    expect(text).not.toMatch(/postgres|password|stack|at .*\.ts/i);
  });
});

test.describe('internal service endpoints', () => {
  const secret = process.env.INTERNAL_API_SECRET!;
  const sign = (ts: string, body: string) => 'sha256=' + createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');

  test('reject unsigned, badly signed and stale requests', async ({ request }) => {
    const body = JSON.stringify({ triggeredBy: 'e2e' });
    expect((await request.post('/internal/reconciliation/run', { data: body, headers: { 'content-type': 'application/json' } })).status()).toBe(401);
    const ts = String(Date.now());
    expect((await request.post('/internal/reconciliation/run', { data: body, headers: { 'x-internal-timestamp': ts, 'x-internal-signature': sign(ts, body + 'x') } })).status()).toBe(401);
    const old = String(Date.now() - 10 * 60_000);
    expect((await request.post('/internal/reconciliation/run', { data: body, headers: { 'x-internal-timestamp': old, 'x-internal-signature': sign(old, body) } })).status()).toBe(401);
  });

  test('accept a correctly signed request exactly once (replay protection)', async ({ request }) => {
    const body = JSON.stringify({ triggeredBy: 'e2e' });
    const ts = String(Date.now());
    const headers = { 'content-type': 'application/json', 'x-internal-timestamp': ts, 'x-internal-signature': sign(ts, body) };
    const first = await request.post('/internal/reconciliation/run', { data: body, headers });
    expect(first.status()).toBe(202);
    const replay = await request.post('/internal/reconciliation/run', { data: body, headers });
    expect(replay.status()).toBe(401);
    expect((await replay.json()).code).toBe('replayed');
  });
});
