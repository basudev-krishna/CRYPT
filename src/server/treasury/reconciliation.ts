/**
 * Treasury reconciliation.
 *
 * For each active network token:
 *   expected on-chain = ledger treasury (hot + cold)
 *                     + virtual venue net   (simulated venue: capital "moved" to the venue never left the chain)
 *                     - in-flight payouts   (mined on chain, not yet settled in the ledger)
 *                     + pending inbound     (deposits seen on chain, not yet received in the ledger)
 *   discrepancy       = actual on-chain balance of all platform addresses - expected
 *
 * Also checks journal integrity, solvency (assets >= customer liabilities) and
 * venue equity vs ledger pool assets. A blocking failure automatically pauses
 * withdrawals and raises a critical risk event.
 */
import type pg from 'pg';
import { many, one, withTransaction, type Db } from '../db-core';
import { parseBase } from '@/lib/money';
import { balanceByPurpose, checkIntegrity } from '../ledger/ledger';
import { listNetworks, getDepositToken } from '../chains/registry';
import type { ChainAdapter } from '../chains/types';
import type { CustodyProvider } from '../custody/types';
import type { TradingVenue } from '../trading/types';
import { fixedToBase } from '../investment/pnl';
import { obligationInvariant } from '../returns/service';
import { isControlEnabled, notify, raiseRiskEvent, recordAudit, serviceActor, setControl, bigintReplacer } from '../ops';

export interface ReconCheck {
  name: string;
  scope: string;
  status: 'ok' | 'warn' | 'fail';
  blocking: boolean;
  detail: Record<string, string | number | boolean | null>;
}

export interface ReconDeps {
  adapterFor: (networkId: number, db: Db) => Promise<ChainAdapter>;
  venueFor: (venueName: string, db: Db) => TradingVenue;
}

export async function runReconciliation(pool: pg.Pool, deps: ReconDeps, triggeredBy: string): Promise<{ runId: string; status: string; checks: ReconCheck[] }> {
  const run = await one<{ id: string }>(pool, "insert into public.reconciliation_runs (status, triggered_by) values ('running', $1) returning id", [triggeredBy]);
  const checks: ReconCheck[] = [];
  try {
    // 1. Journal integrity
    const integrity = await checkIntegrity(pool);
    checks.push({
      name: 'journal_integrity',
      scope: 'ledger',
      status: integrity.unbalancedTokens.length || integrity.cacheMismatches.length ? 'fail' : 'ok',
      blocking: true,
      detail: { unbalancedTokens: integrity.unbalancedTokens.length, cacheMismatches: integrity.cacheMismatches.length },
    });

    for (const network of await listNetworks(pool)) {
      if (network.status !== 'active') continue;
      const token = await getDepositToken(pool, network.id);
      if (!token?.contractAddress) continue;
      const scope = `${network.code}/${token.symbol}`;

      const wallets = await many<{ address: string; kind: string }>(
        pool,
        `select address, kind::text from public.treasury_wallets where network_id = $1 and is_active
         union all select address, 'deposit' from public.deposit_addresses where network_id = $1`,
        [network.id],
      );
      let onchain: bigint | null = 0n;
      const walletBalances: { address: string; kind: string; balance: string }[] = [];
      try {
        const adapter = await deps.adapterFor(network.id, pool);
        for (const wlt of wallets) {
          const b = await adapter.getTokenBalance(token.contractAddress, wlt.address);
          onchain += b;
          if (b !== 0n || wlt.kind !== 'deposit') walletBalances.push({ address: wlt.address, kind: wlt.kind, balance: b.toString() });
        }
      } catch (err) {
        onchain = null;
        checks.push({ name: 'chain_balance_read', scope, status: 'fail', blocking: true, detail: { error: (err as Error).message } });
      }

      const ledgerTreasury = (await balanceByPurpose(pool, 'treasury_hot', token.id)) + (await balanceByPurpose(pool, 'treasury_cold', token.id));
      const v = await one<{ net: string }>(
        pool,
        `select coalesce(sum(case when kind = 'to_venue' then amount_base else -amount_base end), 0)::text as net
           from public.treasury_transfers where token_id = $1 and is_virtual and status = 'completed' and kind in ('to_venue', 'from_venue')`,
        [token.id],
      );
      const virtualNet = parseBase(v.net);
      const inflight = await one<{ s: string }>(
        pool,
        `select coalesce(sum(w.net_amount_base), 0)::text as s
           from public.withdrawal_requests w join public.withdrawal_transactions t on t.withdrawal_id = w.id and t.status = 'broadcast'
          where w.token_id = $1 and w.status = 'broadcast' and t.confirmations > 0`,
        [token.id],
      );
      const inflightOut = parseBase(inflight.s);
      const pend = await one<{ s: string }>(
        pool,
        `select coalesce(sum(amount_base), 0)::text as s from public.deposits
          where token_id = $1 and suspense_entry_id is null and status in ('detected', 'confirming', 'confirmed')`,
        [token.id],
      );
      const pendingInbound = parseBase(pend.s);
      const expected = ledgerTreasury + virtualNet - inflightOut + pendingInbound;
      const discrepancy = onchain === null ? null : onchain - expected;

      if (onchain !== null) {
        checks.push({
          name: 'onchain_vs_ledger',
          scope,
          status: discrepancy === 0n ? 'ok' : 'fail',
          blocking: true,
          detail: {
            onchain: onchain.toString(),
            ledgerTreasury: ledgerTreasury.toString(),
            virtualVenueNet: virtualNet.toString(),
            inflightOut: inflightOut.toString(),
            pendingInbound: pendingInbound.toString(),
            discrepancy: discrepancy!.toString(),
          },
        });
      }

      // Solvency: platform assets must cover customer liabilities.
      const liabilities =
        (await balanceByPurpose(pool, 'user_cash', token.id)) +
        (await balanceByPurpose(pool, 'user_reserved', token.id)) +
        (await balanceByPurpose(pool, 'user_pending_subscription', token.id)) +
        (await balanceByPurpose(pool, 'pool_investor_equity', token.id)) +
        (await balanceByPurpose(pool, 'suspense_deposits', token.id)) +
        (await balanceByPurpose(pool, 'plan_principal', token.id));
      const poolAssets = await balanceByPurpose(pool, 'pool_assets', token.id);
      const assets = ledgerTreasury + poolAssets;
      checks.push({
        name: 'solvency',
        scope,
        status: assets >= liabilities ? 'ok' : 'fail',
        blocking: true,
        detail: { assets: assets.toString(), customerLiabilities: liabilities.toString(), surplus: (assets - liabilities).toString() },
      });

      // Daily returns: the unfunded cost must equal what members are owed (blocking),
      // and payable returns should be covered by the revenue reserve (warning: payouts just wait).
      const obligations = await obligationInvariant(pool, token.id);
      checks.push({
        name: 'return_obligations',
        scope,
        status: obligations.ok ? 'ok' : 'fail',
        blocking: true,
        detail: { returnCost: obligations.cost.toString(), accruedPlusPayable: obligations.owed.toString() },
      });
      const payable = await balanceByPurpose(pool, 'return_payable', token.id);
      const reserve = await balanceByPurpose(pool, 'return_reserve', token.id);
      checks.push({
        name: 'return_coverage',
        scope,
        status: reserve >= payable ? 'ok' : 'warn',
        blocking: false,
        detail: { payable: payable.toString(), revenueReserve: reserve.toString(), shortfall: (payable > reserve ? payable - reserve : 0n).toString() },
      });

      await pool.query(
        `insert into public.treasury_snapshots
           (reconciliation_run_id, network_id, token_id, onchain_balance_base, ledger_treasury_base, virtual_venue_net_base, in_flight_out_base,
            customer_liabilities_base, pool_assets_base, discrepancy_base, wallets)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
        [
          run.id,
          network.id,
          token.id,
          onchain?.toString() ?? null,
          ledgerTreasury.toString(),
          virtualNet.toString(),
          inflightOut.toString(),
          liabilities.toString(),
          poolAssets.toString(),
          discrepancy?.toString() ?? null,
          JSON.stringify(walletBalances),
        ],
      );
    }

    // Venue equity vs ledger pool assets (informational: prices move between valuations).
    const pools = await many<{ id: number; code: string; venue: string; token_id: number; decimals: number }>(
      pool,
      "select p.id, p.code, p.venue, p.token_id, t.decimals from public.investment_pools p join public.supported_tokens t on t.id = p.token_id where p.status = 'active'",
    );
    for (const p of pools) {
      try {
        const venue = deps.venueFor(p.venue, pool);
        const snap = await venue.fetchAccountSnapshot(Number(p.id));
        const venueBase = fixedToBase(snap.equity, Number(p.decimals));
        const ledgerAssets = await balanceByPurpose(pool, 'pool_assets', Number(p.token_id));
        const diff = venueBase - ledgerAssets;
        const tolerance = (ledgerAssets < 0n ? -ledgerAssets : ledgerAssets) / 20n + 1_000_000n; // 5% + 1 token
        checks.push({
          name: 'venue_vs_ledger',
          scope: p.code,
          status: (diff < 0n ? -diff : diff) <= tolerance ? 'ok' : 'warn',
          blocking: false,
          detail: { venueEquity: venueBase.toString(), ledgerPoolAssets: ledgerAssets.toString(), difference: diff.toString(), simulated: venue.isSimulated },
        });
      } catch (err) {
        checks.push({ name: 'venue_vs_ledger', scope: p.code, status: 'warn', blocking: false, detail: { error: (err as Error).message } });
      }
    }

    const stuck = await one<{ n: number }>(
      pool,
      "select count(*)::int as n from public.withdrawal_requests where status in ('processing', 'broadcast') and updated_at < now() - interval '2 hours'",
    );
    checks.push({ name: 'stuck_payouts', scope: 'withdrawals', status: stuck.n ? 'warn' : 'ok', blocking: false, detail: { count: stuck.n } });

    const blockingFail = checks.some((c) => c.blocking && c.status === 'fail');
    const status = blockingFail ? 'discrepancy' : 'ok';
    let autoPaused = false;
    await withTransaction(pool, async (db) => {
      if (blockingFail && !(await isControlEnabled(db, 'withdrawals_paused'))) {
        await setControl(db, 'withdrawals_paused', true, `Automatic pause: reconciliation run ${run.id} found a discrepancy`, serviceActor('reconciliation'));
        autoPaused = true;
      }
      if (blockingFail) {
        await raiseRiskEvent(db, {
          kind: 'reconciliation_discrepancy',
          severity: 'critical',
          subjectType: 'reconciliation_run',
          subjectId: run.id,
          details: { failed: checks.filter((c) => c.status === 'fail') },
        });
        await notify(db, { audience: 'operations', kind: 'reconciliation_discrepancy', channel: 'email', payload: { runId: run.id } });
      }
      await db.query(
        'update public.reconciliation_runs set status = $2, checks = $3::jsonb, finished_at = now(), auto_paused = $4, summary = $5::jsonb where id = $1',
        [run.id, status, JSON.stringify(checks, bigintReplacer), autoPaused, JSON.stringify({ total: checks.length, failed: checks.filter((c) => c.status === 'fail').length })],
      );
      await recordAudit(db, serviceActor('reconciliation'), 'reconciliation.completed', { type: 'reconciliation_run', id: run.id }, { status, autoPaused });
    });
    return { runId: run.id, status, checks };
  } catch (err) {
    await pool.query("update public.reconciliation_runs set status = 'error', finished_at = now(), summary = $2::jsonb where id = $1", [
      run.id,
      JSON.stringify({ error: (err as Error).message }),
    ]);
    throw err;
  }
}

/**
 * Sweep confirmed deposit-address balances to the hot wallet. Movement between
 * platform addresses: no ledger entry, but every sweep is recorded in
 * treasury_transfers. Idempotent per (address, sequence).
 */
export async function sweepDeposits(pool: pg.Pool, custody: CustodyProvider, adapter: ChainAdapter): Promise<number> {
  const network = adapter.network;
  if (!custody.supportsNetwork(network.code)) return 0;
  const token = await getDepositToken(pool, network.id);
  if (!token?.contractAddress) return 0;
  const hot = await one<{ address: string }>(pool, "select address from public.treasury_wallets where network_id = $1 and kind = 'hot' and is_active order by id limit 1", [network.id]);
  const addrs = await many<{ id: string; address: string }>(pool, 'select id, address from public.deposit_addresses where network_id = $1', [network.id]);

  let swept = 0;
  for (const a of addrs) {
    // Only sweep funds whose deposits have been received into the ledger.
    const pending = await one<{ n: number }>(
      pool,
      "select count(*)::int as n from public.deposits where deposit_address_id = $1 and status in ('detected', 'confirming')",
      [a.id],
    );
    if (pending.n > 0) continue;
    const open = await many<{ id: string; amount_base: string }>(
      pool,
      "select id, amount_base::text from public.treasury_transfers where kind = 'sweep' and source_type = 'deposit_address' and source_id like $1 and status = 'pending'",
      [`${a.id}:%`],
    );
    let transferId: string;
    let amount: bigint;
    if (open[0]) {
      transferId = open[0].id;
      amount = parseBase(open[0].amount_base);
    } else {
      const balance = await adapter.getTokenBalance(token.contractAddress, a.address);
      if (balance <= 0n) continue;
      const seq = await one<{ n: number }>(pool, "select count(*)::int as n from public.treasury_transfers where kind = 'sweep' and source_id like $1", [`${a.id}:%`]);
      const row = await one<{ id: string }>(
        pool,
        `insert into public.treasury_transfers (kind, token_id, network_id, from_address, to_address, amount_base, status, is_virtual, source_type, source_id)
         values ('sweep', $1, $2, $3, $4, $5, 'pending', false, 'deposit_address', $6) returning id`,
        [token.id, network.id, a.address, hot.address, balance.toString(), `${a.id}:${seq.n + 1}`],
      );
      transferId = row.id;
      amount = balance;
    }
    const result = await custody.submitTransfer({
      idempotencyKey: `sweep:${transferId}`,
      networkId: network.id,
      networkCode: network.code,
      tokenContract: token.contractAddress,
      fromAddress: a.address,
      toAddress: hot.address,
      amount,
    });
    await pool.query(
      "update public.treasury_transfers set status = $2::text, tx_hash = $3, fee_native_base = $4, completed_at = case when $2::text = 'completed' then now() end where id = $1",
      [transferId, result.status === 'failed' ? 'failed' : 'completed', result.txHash, result.feeNative?.toString() ?? null],
    );
    swept++;
  }
  return swept;
}
