/**
 * Database-level least privilege: what each role can and cannot do, regardless
 * of application code. These are the controls that still hold if the web
 * server is compromised or a customer uses the public anon key directly.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { admin, closePools, createUser, resetAppData, simToken, web, worker } from '../helpers/db';
import { one } from '../../src/server/db-core';

let poolId: number;

beforeEach(async () => {
  await resetAppData();
  await simToken();
  poolId = Number((await one<{ id: number }>(admin, "select id from public.investment_pools where code = 'core-sim'")).id);
});
afterAll(closePools);

/** Run statements as a Supabase API role inside a rolled-back transaction. */
async function asRole<T>(role: 'anon' | 'authenticated', fn: (q: (sql: string, p?: unknown[]) => Promise<unknown>) => Promise<T>, userId?: string): Promise<T> {
  const client = await admin.connect();
  try {
    await client.query('begin');
    if (userId) await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role })]);
    await client.query(`set local role ${role}`);
    return await fn((sql, p) => client.query(sql, p as unknown[]));
  } finally {
    await client.query('rollback').catch(() => undefined);
    client.release();
  }
}

describe('web role (Next.js server) privileges', () => {
  it('cannot change units or cost basis; can only lock units for a redemption', async () => {
    const u = await createUser();
    await worker.query("insert into public.investment_positions (pool_id, user_id, units, cost_basis_base) values ($1, $2, 10, 10000000)", [poolId, u]);
    await expect(web.query('update public.investment_positions set units = 1000000 where user_id = $1', [u])).rejects.toThrow(/permission denied/);
    await expect(web.query('update public.investment_positions set cost_basis_base = 0 where user_id = $1', [u])).rejects.toThrow(/permission denied/);
    await expect(web.query("insert into public.investment_positions (pool_id, user_id, units) values ($1, gen_random_uuid(), 5)", [poolId])).rejects.toThrow(/permission denied/);
    await web.query('update public.investment_positions set units_locked = 1 where user_id = $1', [u]);
  });

  it('cannot execute an order or set its price; can only cancel a pending one', async () => {
    const u = await createUser();
    const o = await one<{ id: string }>(web, "insert into public.investment_orders (pool_id, user_id, kind, amount_base, idempotency_key) values ($1, $2, 'subscription', 1000000, $3) returning id", [poolId, u, `${u}:k`]);
    await expect(web.query("update public.investment_orders set navpu = 1 where id = $1", [o.id])).rejects.toThrow(/permission denied/);
    await expect(web.query("update public.investment_orders set status = 'executed' where id = $1", [o.id])).rejects.toThrow(/only cancel/);
    await web.query("update public.investment_orders set status = 'cancelled' where id = $1", [o.id]);
    await expect(web.query("update public.investment_orders set status = 'pending' where id = $1", [o.id])).rejects.toThrow(/only cancel/);
  });

  it('cannot write trading, valuation or allocation records', async () => {
    const u = await createUser();
    await expect(
      web.query("insert into public.trade_executions (pool_id, venue, external_execution_id, symbol, side, quantity, price, fee_asset, executed_at, is_simulated) values ($1, 'v', 'x', 'A/B', 'buy', 1, 1, 'B', now(), true)", [poolId]),
    ).rejects.toThrow(/permission denied/);
    await expect(web.query("insert into public.portfolio_valuations (pool_id, valuation_date, period_key, status, is_simulated) values ($1, now(), 'x', 'final', true)", [poolId])).rejects.toThrow(/permission denied/);
    await expect(
      web.query(
        'insert into public.performance_allocations (valuation_id, pool_id, user_id, units_held, navpu_start, navpu_end, pnl_base, realized_share_base, unrealized_share_base, fees_share_base, is_simulated) values (1, $1, $2, 1, 1, 1, 1000000, 0, 0, 0, true)',
        [poolId, u],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(web.query("insert into public.withdrawal_transactions (withdrawal_id, attempt, custody_provider, custody_request_id, status, is_simulated) values (gen_random_uuid(), 1, 'x', 'x', 'confirmed', true)")).rejects.toThrow(/permission denied/);
  });

  it('cannot alter or erase the audit trail', async () => {
    await web.query("insert into public.audit_events (actor_type, actor_id, action) values ('user', 'u', 'test.action')");
    await expect(web.query("update public.audit_events set action = 'edited'")).rejects.toThrow(/permission denied|not allowed/);
    await expect(web.query('delete from public.audit_events')).rejects.toThrow(/permission denied|not allowed/);
    await expect(admin.query('delete from public.audit_events')).rejects.toThrow(/not allowed/); // append-only even for the owner
  });

  it('accepts each internal request signature only once', async () => {
    const sig = `sha256=${'ab'.repeat(32)}`;
    expect((await web.query('select private.claim_internal_nonce($1) as ok', [sig])).rows[0].ok).toBe(true);
    expect((await web.query('select private.claim_internal_nonce($1) as ok', [sig])).rows[0].ok).toBe(false);
  });
});

describe('public API roles (anon key used directly against PostgREST)', () => {
  it('cannot call ledger, nonce or rate-limit functions', async () => {
    const u = await createUser();
    for (const sql of [
      "select ledger.post_entry('x12345678', 't', 't', 't', 't', 't', '[]'::jsonb)",
      'select ledger.ensure_account(\'user_cash\', 1::smallint, gen_random_uuid(), null)',
      "select private.claim_internal_nonce('x')",
      "select public.rate_limit_hit('x', 60, 1)",
    ]) {
      await expect(asRole('authenticated', (q) => q(sql), u)).rejects.toThrow(/permission denied/);
      await expect(asRole('anon', (q) => q(sql))).rejects.toThrow(/permission denied/);
    }
  });

  it('cannot read another customer\'s rows or any ledger data, and cannot write anything', async () => {
    const a = await createUser();
    const b = await createUser();
    await worker.query("insert into public.notification_events (user_id, kind, channel) values ($1, 'private', 'in_app')", [b]);
    const rows = await asRole('authenticated', (q) => q('select user_id from public.notification_events') as Promise<{ rows: unknown[] }>, a);
    expect(rows.rows).toHaveLength(0);
    await expect(asRole('authenticated', (q) => q('select * from public.journal_lines'), a)).rejects.toThrow(/permission denied/);
    await expect(asRole('authenticated', (q) => q('select * from public.user_ledger_balances'), a)).rejects.toThrow(/permission denied/);
    await expect(asRole('authenticated', (q) => q("update public.user_profiles set account_status = 'active' where user_id = $1", [a]), a)).rejects.toThrow(/permission denied/);
    await expect(asRole('authenticated', (q) => q("insert into public.staff_roles (user_id, role) values ($1, 'admin')", [a]), a)).rejects.toThrow(/permission denied/);
  });
});
