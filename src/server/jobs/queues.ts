/**
 * Durable job queues (pg-boss, stored in Postgres schema `pgboss`).
 * Every handler is idempotent: a job may run more than once (retries, worker
 * crash after commit) without duplicating credits, allocations or payouts.
 */
export const QUEUES = {
  chainIngest: 'chain.ingest',
  depositRefresh: 'deposit.refresh',
  depositCredit: 'deposit.credit',
  depositInvestigate: 'deposit.investigate',
  allocationPost: 'allocation.post',
  correctionPost: 'correction.post',
  referralRewards: 'referral.rewards',
  adjustmentPost: 'adjustment.post',
  returnsProcess: 'returns.process',
  treasurySweep: 'treasury.sweep',
  tradesImport: 'trades.import',
  valuationRun: 'valuation.run',
  withdrawalProcess: 'withdrawal.process',
  withdrawalMonitor: 'withdrawal.monitor',
  reconciliationRun: 'reconciliation.run',
  notificationsDispatch: 'notifications.dispatch',
  maintenance: 'ops.maintenance',
  deadLetter: 'dead-letter',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface JobPayloads {
  'chain.ingest': { networkId: number };
  'deposit.refresh': { depositId: string };
  'deposit.credit': { depositId: string };
  'deposit.investigate': { networkId: number; txHash: string; requestedBy: string };
  'allocation.post': { allocationId: string };
  'correction.post': { correctionId: string };
  'referral.rewards': Record<string, never>;
  'adjustment.post': { adjustmentId: string };
  'returns.process': Record<string, never>;
  'treasury.sweep': { networkId: number };
  'trades.import': { poolId: number };
  'valuation.run': { poolId: number };
  'withdrawal.process': { withdrawalId: string };
  'withdrawal.monitor': { withdrawalId: string };
  'reconciliation.run': { triggeredBy: string };
  'notifications.dispatch': Record<string, never>;
  'ops.maintenance': Record<string, never>;
  'dead-letter': Record<string, unknown>;
}
