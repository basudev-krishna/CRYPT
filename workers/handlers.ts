/**
 * Job handlers. Each one is safe to re-run; correctness never depends on a job
 * running exactly once.
 */
import type pg from 'pg';
import { many, withTransaction, type Db } from '../src/server/db-core';
import { getAdapter, getNetwork, listNetworks } from '../src/server/chains/registry';
import { getCustodyProvider } from '../src/server/custody/simulated';
import { getScreeningProvider } from '../src/server/compliance/compliance';
import { creditDeposit, ingestNetwork, investigateTransaction, refreshDeposit } from '../src/server/deposits/service';
import { getTradingVenue, SimulatedVenue } from '../src/server/trading/simulated';
import { importTrades, runValuation } from '../src/server/investment/valuation';
import { getPool } from '../src/server/investment/orders';
import { expireUnconfirmed, listOpenWithdrawalIds, monitorWithdrawal, processWithdrawal, type PayoutDeps } from '../src/server/withdrawals/service';
import { runReconciliation, sweepDeposits } from '../src/server/treasury/reconciliation';
import { failCorrection, listPendingAllocationIds, listPendingCorrectionIds, postAllocation, postCorrection } from '../src/server/deposits/allocations';
import { detectReferralRewards, listApprovedReferralRewardIds, postReferralReward } from '../src/server/referrals/rewards';
import { detectMatchingRewards, evaluateRanks, listApprovedProgramRewardIds, postProgramReward } from '../src/server/referrals/program';
import { listPendingAdjustmentIds, postAdjustment } from '../src/server/adjustments/manual';
import {
  accrueSubscription,
  listAccruingSubscriptionIds,
  listPendingSubscriptionIds,
  listReturnTokenIds,
  matureAccruals,
  openSubscription,
  redeemSubscription,
  settlePayables,
} from '../src/server/returns/service';
import { notify, raiseRiskEvent, serviceActor } from '../src/server/ops';
import { dispatchRiskAlerts, getAlertSender } from '../src/server/alerts';
import type { JobPayloads } from '../src/server/jobs/queues';

export type Enqueue = <K extends keyof JobPayloads>(name: K, data: JobPayloads[K], opts?: { singletonKey?: string; startAfter?: Date | number }) => Promise<void>;

export function createHandlers(pool: pg.Pool, enqueue: Enqueue, env: NodeJS.ProcessEnv = process.env) {
  const adapterFor = async (networkId: number, db: Db) => getAdapter(await getNetwork(db, networkId), db, env);
  const payoutDeps = (): PayoutDeps => ({ custody: getCustodyProvider(pool, env), adapterFor, screening: getScreeningProvider(env) });

  return {
    /** Scan a network, then fan out confirmation/credit work for open deposits. */
    async chainIngest({ networkId }: JobPayloads['chain.ingest']) {
      const adapter = await adapterFor(networkId, pool);
      await ingestNetwork(pool, adapter);
      const open = await many<{ id: string; status: string }>(
        pool,
        "select id, status from public.deposits where network_id = $1 and status in ('detected', 'confirming', 'confirmed') limit 500",
        [networkId],
      );
      for (const d of open) {
        if (d.status === 'confirmed') await enqueue('deposit.credit', { depositId: d.id }, { singletonKey: `credit:${d.id}` });
        else await enqueue('deposit.refresh', { depositId: d.id }, { singletonKey: `refresh:${d.id}` });
      }
    },

    async depositRefresh({ depositId }: JobPayloads['deposit.refresh']) {
      const outcome = await withTransaction(pool, async (db) => {
        const row = await many<{ network_id: number }>(db, 'select network_id from public.deposits where id = $1', [depositId]);
        if (!row[0]) return 'unchanged';
        return refreshDeposit(db, await adapterFor(Number(row[0].network_id), db), depositId);
      });
      if (outcome === 'confirmed') await enqueue('deposit.credit', { depositId }, { singletonKey: `credit:${depositId}` });
    },

    async depositCredit({ depositId }: JobPayloads['deposit.credit']) {
      await withTransaction(pool, (db) => creditDeposit(db, depositId, { screening: getScreeningProvider(env) }));
    },

    async depositInvestigate({ networkId, txHash, requestedBy }: JobPayloads['deposit.investigate']) {
      await withTransaction(pool, async (db) => investigateTransaction(db, await adapterFor(networkId, db), txHash, { type: 'staff', id: requestedBy }));
    },

    async allocationPost({ allocationId }: JobPayloads['allocation.post']) {
      await withTransaction(pool, (db) => postAllocation(db, allocationId, serviceActor('allocation-poster')));
    },

    async adjustmentPost({ adjustmentId }: JobPayloads['adjustment.post']) {
      await withTransaction(pool, (db) => postAdjustment(db, adjustmentId, serviceActor('adjustment-poster')));
    },

    /**
     * Record referral, matching and rank rewards that became due, then pay the
     * approved ones (each in its own transaction).
     */
    async referralRewards() {
      await withTransaction(pool, (db) => detectReferralRewards(db));
      await withTransaction(pool, (db) => detectMatchingRewards(db));
      await withTransaction(pool, (db) => evaluateRanks(db));
      for (const id of await listApprovedReferralRewardIds(pool)) {
        await withTransaction(pool, (db) => postReferralReward(db, id, serviceActor('referral-rewards')));
      }
      for (const id of await listApprovedProgramRewardIds(pool)) {
        await withTransaction(pool, (db) => postProgramReward(db, id, serviceActor('program-rewards')));
      }
    },

    /**
     * Fixed daily returns: open requested subscriptions, return requested
     * principal, accrue finished days, move due returns to payable, then pay
     * them from the revenue reserve. One transaction per step and subject, so
     * a failure in one never blocks the others; every step is idempotent.
     */
    async returnsProcess() {
      const actor = serviceActor('daily-returns');
      for (const id of await listPendingSubscriptionIds(pool, 'pending')) await withTransaction(pool, (db) => openSubscription(db, id, actor));
      for (const id of await listAccruingSubscriptionIds(pool)) await withTransaction(pool, (db) => accrueSubscription(db, id, actor));
      for (const id of await listPendingSubscriptionIds(pool, 'redeem_requested')) await withTransaction(pool, (db) => redeemSubscription(db, id, actor));
      while ((await withTransaction(pool, (db) => matureAccruals(db, actor))) > 0);
      for (const tokenId of await listReturnTokenIds(pool)) await withTransaction(pool, (db) => settlePayables(db, tokenId, actor));
    },

    /** A reversal the ledger refuses (e.g. the member already spent the cash) is recorded as failed, not retried forever. */
    async correctionPost({ correctionId }: JobPayloads['correction.post']) {
      try {
        await withTransaction(pool, (db) => postCorrection(db, correctionId, serviceActor('correction-poster')));
      } catch (err) {
        const code = (err as { code?: string }).code;
        // P0001/P0002: ledger rule violations (e.g. negative customer balance). Anything else is transient: retry.
        if (code !== 'P0001' && code !== 'P0002') throw err;
        await withTransaction(pool, (db) => failCorrection(db, correctionId, (err as Error).message));
      }
    },

    async treasurySweep({ networkId }: JobPayloads['treasury.sweep']) {
      await sweepDeposits(pool, getCustodyProvider(pool, env), await adapterFor(networkId, pool));
    },

    /** For simulated pools: let the simulated venue trade, then import executions. */
    async tradesImport({ poolId }: JobPayloads['trades.import']) {
      const pool_ = await getPool(pool, poolId);
      const venue = getTradingVenue(pool, pool_.venue, env);
      if (venue instanceof SimulatedVenue) await venue.runStrategy(poolId);
      await withTransaction(pool, (db) => importTrades(db, getTradingVenue(db, pool_.venue, env), pool_, serviceActor('trade-importer')));
    },

    async valuationRun({ poolId }: JobPayloads['valuation.run']) {
      const p = await getPool(pool, poolId);
      await withTransaction(pool, (db) => runValuation(db, getTradingVenue(db, p.venue, env), poolId, serviceActor('valuation')));
    },

    async withdrawalProcess({ withdrawalId }: JobPayloads['withdrawal.process']) {
      const res = await processWithdrawal(pool, payoutDeps(), withdrawalId);
      if (res.outcome === 'broadcast') await enqueue('withdrawal.monitor', { withdrawalId }, { singletonKey: `monitor:${withdrawalId}`, startAfter: 5 });
    },

    async withdrawalMonitor({ withdrawalId }: JobPayloads['withdrawal.monitor']) {
      const outcome = await monitorWithdrawal(pool, payoutDeps(), withdrawalId);
      if (outcome === 'replaced') await enqueue('withdrawal.process', { withdrawalId }, { singletonKey: `process:${withdrawalId}` });
    },

    async reconciliationRun({ triggeredBy }: JobPayloads['reconciliation.run']) {
      await runReconciliation(pool, { adapterFor, venueFor: (name, db) => getTradingVenue(db, name, env) }, triggeredBy);
    },

    /**
     * In-app notifications are delivered by being stored. Email delivery has no
     * provider integrated yet: those are marked failed with an explicit reason
     * rather than pretending they were sent.
     */
    async notificationsDispatch() {
      await pool.query("update public.notification_events set status = 'sent', sent_at = now() where status = 'pending' and channel = 'in_app'");
      await pool.query(
        "update public.notification_events set status = 'failed', attempts = attempts + 1, payload = payload || '{\"delivery_error\":\"no email provider configured\"}'::jsonb where status = 'pending' and channel = 'email'",
      );
      const sender = getAlertSender(env);
      if (sender) {
        const r = await dispatchRiskAlerts(pool, sender, { appEnv: env.APP_ENV ?? 'development' });
        // Not thrown: unsent events stay queued in the table and retry on the next tick, whereas a
        // throw would dead-letter this job and raise yet another alert about the same outage.
        if (r.failed > 0) console.error(JSON.stringify({ t: new Date().toISOString(), msg: 'alerts.delivery_failed', sent: r.sent }));
      }
    },

    async maintenance() {
      await expireUnconfirmed(pool);
    },

    /** Periodic fan-out (the scheduler). Uses singleton keys so overlapping ticks don't pile up. */
    async tick(kind: 'fast' | 'medium' | 'slow') {
      if (kind === 'fast') {
        for (const n of await listNetworks(pool)) {
          if (n.status === 'active') await enqueue('chain.ingest', { networkId: n.id }, { singletonKey: `ingest:${n.id}` });
        }
        for (const id of await listOpenWithdrawalIds(pool, 'reserved')) await enqueue('withdrawal.process', { withdrawalId: id }, { singletonKey: `process:${id}` });
        for (const id of await listOpenWithdrawalIds(pool, 'processing')) await enqueue('withdrawal.process', { withdrawalId: id }, { singletonKey: `process:${id}` });
        for (const id of await listOpenWithdrawalIds(pool, 'broadcast')) await enqueue('withdrawal.monitor', { withdrawalId: id }, { singletonKey: `monitor:${id}` });
        for (const id of await listPendingAllocationIds(pool)) await enqueue('allocation.post', { allocationId: id }, { singletonKey: `allocation:${id}` });
        for (const id of await listPendingCorrectionIds(pool)) await enqueue('correction.post', { correctionId: id }, { singletonKey: `correction:${id}` });
        for (const id of await listPendingAdjustmentIds(pool)) await enqueue('adjustment.post', { adjustmentId: id }, { singletonKey: `adjustment:${id}` });
        await enqueue('referral.rewards', {}, { singletonKey: 'referral-rewards' });
        await enqueue('notifications.dispatch', {}, { singletonKey: 'notifications' });
        await enqueue('ops.maintenance', {}, { singletonKey: 'maintenance' });
      } else if (kind === 'medium') {
        // Daily returns: accrual is per UTC day; member requests also enqueue this directly.
        await enqueue('returns.process', {}, { singletonKey: 'returns' });
        const pools = await many<{ id: number }>(pool, "select id from public.investment_pools where status = 'active'");
        for (const p of pools) {
          await enqueue('trades.import', { poolId: Number(p.id) }, { singletonKey: `import:${p.id}` });
          await enqueue('valuation.run', { poolId: Number(p.id) }, { singletonKey: `valuation:${p.id}`, startAfter: 30 });
        }
        for (const n of await listNetworks(pool)) {
          if (n.status === 'active') await enqueue('treasury.sweep', { networkId: n.id }, { singletonKey: `sweep:${n.id}` });
        }
      } else {
        await enqueue('reconciliation.run', { triggeredBy: 'schedule' }, { singletonKey: 'reconciliation' });
      }
    },

    async deadLetter(job: { name?: string; data: unknown; id: string }) {
      await withTransaction(pool, async (db) => {
        await raiseRiskEvent(db, {
          kind: 'job_dead_lettered',
          severity: 'high',
          subjectType: 'job',
          subjectId: job.id,
          details: { data: job.data as Record<string, unknown> },
        });
        await notify(db, { audience: 'operations', kind: 'job_dead_lettered', payload: { jobId: job.id } });
      });
    },
  };
}
