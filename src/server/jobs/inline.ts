/**
 * Inline jobs: run the worker's job handlers inside a web request, for
 * deployments without a worker process (JOBS_MODE=inline). The admin operates
 * the platform by hand, so each recorded action is posted straight away and
 * "Sync & process now" runs one pass of the worker's schedule: scan the chain,
 * credit deposits, post allocations/adjustments/rewards, enrol deposits and
 * accrue daily returns (missed days are caught up), reconcile, send alerts.
 *
 * The handlers are the worker's own (workers/handlers.ts), idempotent and
 * safe to run twice, and they use the worker's database role, so every ledger
 * rule and guard still applies. The trade-off: the web server holds the worker
 * role's credentials. The same pre-flight checks as the worker run first.
 */
import 'server-only';
import pg from 'pg';
import { configurePgTypes } from '../db-core';
import { createHandlers } from '../../../workers/handlers';
import { workerStartupError } from '../../../workers/startup-guard';
import type { JobPayloads } from './queues';

configurePgTypes();

type Handlers = ReturnType<typeof createHandlers>;
type JobName = Exclude<keyof JobPayloads, 'dead-letter'>;

const DISPATCH: Record<JobName, (h: Handlers, data: never) => Promise<void>> = {
  'chain.ingest': (h, d) => h.chainIngest(d),
  'deposit.refresh': (h, d) => h.depositRefresh(d),
  'deposit.credit': (h, d) => h.depositCredit(d),
  'deposit.investigate': (h, d) => h.depositInvestigate(d),
  'allocation.post': (h, d) => h.allocationPost(d),
  'correction.post': (h, d) => h.correctionPost(d),
  'referral.rewards': (h) => h.referralRewards(),
  'adjustment.post': (h, d) => h.adjustmentPost(d),
  'returns.process': (h) => h.returnsProcess(),
  'treasury.sweep': (h, d) => h.treasurySweep(d),
  'trades.import': (h, d) => h.tradesImport(d),
  'valuation.run': (h, d) => h.valuationRun(d),
  'withdrawal.process': (h, d) => h.withdrawalProcess(d),
  'withdrawal.monitor': (h, d) => h.withdrawalMonitor(d),
  'reconciliation.run': (h, d) => h.reconciliationRun(d),
  'notifications.dispatch': (h) => h.notificationsDispatch(),
  'ops.maintenance': (h) => h.maintenance(),
};

export class InlineJobsError extends Error {
  override name = 'InlineJobsError';
  readonly code = 'jobs_unavailable';
}

let pool: pg.Pool | undefined;

function workerPool(): pg.Pool {
  const refusal = workerStartupError(process.env);
  if (refusal) throw new InlineJobsError(`Background processing is not configured: ${refusal}`);
  pool ??= new pg.Pool({ connectionString: process.env.DATABASE_URL_WORKER, max: 3, idleTimeoutMillis: 10_000, statement_timeout: 60_000, application_name: 'elitewhale-inline-jobs' });
  return pool;
}

export interface RunSummary {
  jobs: number;
  failed: { job: string; error: string }[];
}

const MAX_JOBS = 1000;

/** Run jobs and everything they schedule, each at most once per run. Failures are collected, not thrown. */
async function drain(seed: (h: Handlers) => Promise<void>): Promise<RunSummary> {
  const queue: [JobName, unknown][] = [];
  const h = createHandlers(workerPool(), async (name, data) => {
    if (name !== 'dead-letter') queue.push([name as JobName, data]);
  });
  const summary: RunSummary = { jobs: 0, failed: [] };
  try {
    await seed(h);
  } catch (err) {
    summary.failed.push({ job: 'schedule', error: (err as Error).message });
  }
  const seen = new Set<string>();
  while (queue.length && summary.jobs < MAX_JOBS) {
    const [name, data] = queue.shift()!;
    const key = `${name}:${JSON.stringify(data)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    summary.jobs++;
    try {
      await DISPATCH[name](h, data as never);
    } catch (err) {
      summary.failed.push({ job: name, error: (err as Error).message });
      console.error(JSON.stringify({ t: new Date().toISOString(), msg: 'inline.job_error', job: name, error: (err as Error).message }));
    }
  }
  return summary;
}

/** Run one job now (and what it schedules). */
export function runJobInline<K extends JobName>(name: K, data: JobPayloads[K]): Promise<RunSummary> {
  return drain(async (h) => {
    await DISPATCH[name](h, data as never);
  });
}

/** One pass of the worker's whole schedule. */
export function runAllInline(): Promise<RunSummary> {
  return drain(async (h) => {
    await h.tick('fast');
    await h.tick('medium');
    await h.tick('slow');
  });
}
