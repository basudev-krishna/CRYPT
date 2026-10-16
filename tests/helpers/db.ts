/**
 * Integration-test database helpers.
 *
 * Tests run against the LOCAL Supabase Postgres. `resetAppData()` truncates all
 * application (non-reference) tables, so running the integration suite wipes
 * local demo data; `npm run db:reset` restores the seed.
 *
 * Services under test connect as app_worker / app_web, so table grants and the
 * "no direct ledger writes" rule are exercised for real. Only setup/teardown
 * uses the superuser connection.
 */
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { configurePgTypes, one, type Db } from '../../src/server/db-core';
import { insertSimTransfer } from '../../src/server/chains/simulated';
import { SimulatedChainAdapter } from '../../src/server/chains/simulated';
import { getNetwork } from '../../src/server/chains/registry';
import { parseUnits } from '../../src/lib/money';

configurePgTypes();

function requireLocal(url: string | undefined, name: string): string {
  if (!url) throw new Error(`${name} must be set for integration tests (see .env.example)`);
  const host = new URL(url).hostname;
  if (!['127.0.0.1', 'localhost'].includes(host)) throw new Error(`Refusing to run destructive tests against non-local database host ${host}`);
  return url;
}

export const admin = new pg.Pool({ connectionString: requireLocal(process.env.DATABASE_URL_ADMIN, 'DATABASE_URL_ADMIN'), max: 3 });
export const worker = new pg.Pool({ connectionString: requireLocal(process.env.DATABASE_URL_WORKER, 'DATABASE_URL_WORKER'), max: 10 });
export const web = new pg.Pool({ connectionString: requireLocal(process.env.DATABASE_URL_WEB, 'DATABASE_URL_WEB'), max: 10 });

const APP_TABLES = [
  'journal_lines', 'journal_entries', 'account_balances', 'ledger_accounts',
  'deposits', 'chain_transactions', 'network_scan_state', 'deposit_addresses', 'sim_chain_transfers',
  'investment_orders', 'investment_positions', 'performance_allocations', 'portfolio_valuations',
  'trade_executions', 'trade_import_batches', 'sim_venue_executions', 'treasury_transfers',
  'withdrawal_transactions', 'withdrawal_destinations', 'withdrawal_requests',
  'treasury_snapshots', 'reconciliation_runs', 'risk_events', 'audit_events', 'notification_events',
  'rate_limits', 'internal_request_nonces', 'kyc_records', 'staff_roles',
];

export async function resetAppData(): Promise<void> {
  await admin.query(`truncate ${APP_TABLES.map((t) => `public.${t}`).join(', ')} restart identity cascade`);
  await admin.query("update public.system_controls set enabled = false, reason = null");
  await admin.query('update public.investment_pools set high_water_mark = inception_navpu');
  await admin.query("delete from public.supported_networks where code like 'test-%'");
  await admin.query("delete from public.user_profiles where email like '%@test.local'");
  await admin.query("delete from auth.users where email like '%@test.local'");
}

export async function closePools(): Promise<void> {
  await Promise.all([admin.end(), worker.end(), web.end()]);
}

export async function createUser(opts: { kyc?: 'approved' | 'pending' | 'none'; status?: string } = {}): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', now(), now(), now(), '{}', '{}')`,
    [id, `${id.slice(0, 8)}@test.local`],
  );
  if ((opts.kyc ?? 'approved') !== 'none') {
    await admin.query("insert into public.kyc_records (user_id, status, full_name, submitted_at) values ($1, $2, 'Test User', now())", [id, opts.kyc ?? 'approved']);
  }
  if (opts.status) await admin.query('update public.user_profiles set account_status = $2 where user_id = $1', [id, opts.status]);
  return id;
}

export async function simNetwork(db: Db = worker) {
  return getNetwork(db, 'sim-evm');
}

export async function simToken() {
  return one<{ id: number; contract_address: string; decimals: number }>(
    admin,
    "select t.id, t.contract_address, t.decimals from public.supported_tokens t join public.supported_networks n on n.id = t.network_id where n.code = 'sim-evm' and not t.is_native",
  );
}

export async function simAdapter(db: Db = worker) {
  return new SimulatedChainAdapter(await simNetwork(db), db);
}

/** Simulated inbound transfer, `confirmations` deep (0 = not yet mined). */
export async function simDeposit(to: string, amount: bigint, confirmations: number, opts: { success?: boolean; from?: string; contract?: string } = {}) {
  const net = await simNetwork(admin);
  const token = await simToken();
  return insertSimTransfer(admin, {
    networkId: net.id,
    tokenContract: opts.contract ?? token.contract_address,
    from: opts.from ?? '0x1111111111111111111111111111111111111111',
    to,
    amount,
    success: opts.success,
    delayBlocks: 1 - confirmations,
  });
}

/** Age every simulated transfer by `blocks` blocks (simulates time passing). */
export async function mineBlocks(blocks: number) {
  await admin.query('update public.sim_chain_transfers set block_number = block_number - $1', [blocks]);
}

export const usdt = (amount: string) => parseUnits(amount, 6);

export async function balanceOf(purpose: string, tokenId: number, userId?: string): Promise<bigint> {
  const r = await one<{ b: string }>(
    admin,
    `select coalesce(sum(b.balance), 0)::text as b from public.ledger_accounts a join public.account_balances b on b.account_id = a.id
      where a.purpose = $1 and a.token_id = $2 and ($3::uuid is null or a.user_id = $3)`,
    [purpose, tokenId, userId ?? null],
  );
  return BigInt(r.b);
}
