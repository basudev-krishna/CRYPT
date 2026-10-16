import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { admin, closePools, createUser, resetAppData, simNetwork, simToken, usdt, worker } from '../helpers/db';
import { ensureAccount, postEntry, transfer } from '../../src/server/ledger/ledger';
import { insertSimTransfer, SimulatedChainAdapter } from '../../src/server/chains/simulated';
import { getNetwork } from '../../src/server/chains/registry';
import { runReconciliation } from '../../src/server/treasury/reconciliation';
import { SimulatedVenue } from '../../src/server/trading/simulated';
import { one, type Db } from '../../src/server/db-core';

const HOT = '0x0000000000000000000000000000000000000a07';
let tokenId: number;
let networkId: number;
let contract: string;

const deps = {
  adapterFor: async (id: number, db: Db) => new SimulatedChainAdapter(await getNetwork(db, id), db),
  venueFor: (_name: string, db: Db) => new SimulatedVenue(db, {} as NodeJS.ProcessEnv),
};

beforeEach(async () => {
  await resetAppData();
  const t = await simToken();
  tokenId = t.id;
  contract = t.contract_address;
  networkId = (await simNetwork()).id;
});
afterAll(closePools);

async function capital(amount: bigint, onChain: bigint = amount) {
  await insertSimTransfer(admin, { networkId, tokenContract: contract, from: '0x0000000000000000000000000000000000000001', to: HOT, amount: onChain, delayBlocks: -20 });
  const hot = await ensureAccount(worker, 'treasury_hot', tokenId);
  const eq = await ensureAccount(worker, 'owner_equity', tokenId);
  await postEntry(worker, { idempotencyKey: `test:cap:${amount}`, eventType: 'capital', sourceType: 'test', sourceId: 'cap', description: 'operator capital', postedBy: 'service:test', lines: transfer(hot, eq, amount) });
}

describe('treasury reconciliation', () => {
  it('passes when on-chain balances match the ledger', async () => {
    await capital(usdt('1000'));
    const r = await runReconciliation(worker, deps, 'test');
    expect(r.status).toBe('ok');
    expect(r.checks.find((c) => c.name === 'onchain_vs_ledger')?.detail.discrepancy).toBe('0');
  });

  it('detects a discrepancy, raises a critical event and automatically pauses withdrawals', async () => {
    await capital(usdt('1000'), usdt('990')); // 10 missing on chain
    const r = await runReconciliation(worker, deps, 'test');
    expect(r.status).toBe('discrepancy');
    expect(r.checks.find((c) => c.name === 'onchain_vs_ledger')?.detail.discrepancy).toBe('-10000000');
    const paused = await one<{ enabled: boolean }>(admin, "select enabled from public.system_controls where key = 'withdrawals_paused'");
    expect(paused.enabled).toBe(true);
    expect((await admin.query("select count(*)::int as n from public.risk_events where kind = 'reconciliation_discrepancy' and severity = 'critical'")).rows[0].n).toBe(1);
    const run = await one<{ auto_paused: boolean }>(admin, 'select auto_paused from public.reconciliation_runs where id = $1', [r.runId]);
    expect(run.auto_paused).toBe(true);
  });

  it('flags insolvency when customer liabilities exceed assets', async () => {
    const u = await createUser();
    await capital(usdt('100'));
    // A customer liability with no matching asset (e.g. a bad manual credit) breaks solvency.
    const cash = await ensureAccount(worker, 'user_cash', tokenId, { userId: u });
    const eq = await ensureAccount(worker, 'owner_equity', tokenId);
    await postEntry(worker, { idempotencyKey: 'test:bad-credit', eventType: 'test', sourceType: 'test', sourceId: 'x', description: 'liability without asset', postedBy: 'service:test', lines: transfer(eq, cash, usdt('150')) });
    const r = await runReconciliation(worker, deps, 'test');
    expect(r.checks.find((c) => c.name === 'solvency')?.status).toBe('fail');
  });
});

describe('row level security for the public API roles', () => {
  async function asUser(userId: string, fn: (q: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>) => Promise<void>) {
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: 'authenticated' })]);
      await client.query('set local role authenticated');
      await fn((sql) => client.query(sql));
    } finally {
      await client.query('rollback');
      client.release();
    }
  }

  it('lets a customer read only their own rows and nothing from the ledger', async () => {
    const a = await createUser();
    const b = await createUser();
    await admin.query(
      "insert into public.deposit_addresses (user_id, network_id, address, custody_provider) values ($1, $3, '0xaaaa000000000000000000000000000000000001', 'test'), ($2, $3, '0xbbbb000000000000000000000000000000000002', 'test')",
      [a, b, networkId],
    );
    await asUser(a, async (q) => {
      const rows = (await q('select user_id from public.deposit_addresses')).rows;
      expect(rows).toEqual([{ user_id: a }]);
      const profiles = (await q('select user_id from public.user_profiles')).rows;
      expect(profiles).toEqual([{ user_id: a }]);
    });
    await asUser(a, async (q) => {
      await expect(q('select * from public.journal_entries')).rejects.toThrow(/permission denied/);
    });
    await asUser(a, async (q) => {
      await expect(q('select * from public.account_balances')).rejects.toThrow(/permission denied/);
    });
    await asUser(a, async (q) => {
      await expect(q("update public.user_profiles set account_status = 'active'")).rejects.toThrow(/permission denied/);
    });
    await asUser(a, async (q) => {
      await expect(q("select ledger.post_entry('x', 'x', 'x', 'x', 'x', 'x', '[]'::jsonb)")).rejects.toThrow(/permission denied/);
    });
  });

  it('hides everything from anonymous callers except active reference data', async () => {
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query('set local role anon');
      const nets = await client.query('select code from public.supported_networks');
      expect(nets.rows.map((r) => r.code)).toEqual(['sim-evm']);
      await expect(client.query('select * from public.deposits')).rejects.toThrow(/permission denied/);
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
});
