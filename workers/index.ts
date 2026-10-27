/**
 * Background worker process. Run separately from the web app:
 *   npm run worker
 *
 * Uses DATABASE_URL_WORKER (role app_worker). Queues are durable (pg-boss in
 * Postgres) with retries, exponential backoff and a dead-letter queue.
 */
import { config } from 'dotenv';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { configurePgTypes } from '../src/server/db-core';
import { QUEUES, type JobPayloads, type QueueName } from '../src/server/jobs/queues';
import { createHandlers, type Enqueue } from './handlers';
import { workerStartupError } from './startup-guard';

config({ path: ['.env.local', '.env'], quiet: true });
configurePgTypes();

const startupError = workerStartupError(process.env);
if (startupError) {
  console.error(startupError);
  process.exit(1);
}
const connectionString = process.env.DATABASE_URL_WORKER!;

const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

async function main() {
  const pool = new pg.Pool({ connectionString, max: 10, application_name: 'elitewhale-worker', statement_timeout: 60_000 });
  const boss = new PgBoss({ connectionString, schema: 'pgboss', application_name: 'elitewhale-boss' });
  boss.on('error', (err) => log('pgboss.error', { error: String(err) }));
  await boss.start();

  // Let the web role enqueue jobs (internal endpoints) without owning the schema.
  await pool.query('grant usage on schema pgboss to app_web');
  await pool.query('grant select, insert, update on all tables in schema pgboss to app_web');
  await pool.query('grant execute on all functions in schema pgboss to app_web');
  // The web client registers an instance row and prunes dead instances.
  await pool.query('grant delete on pgboss.instance to app_web');
  // Tables pg-boss creates later (e.g. new stats partitions) get the same grants.
  await pool.query('alter default privileges in schema pgboss grant select, insert, update on tables to app_web');

  await boss.createQueue(QUEUES.deadLetter, { retryLimit: 0 }).catch(() => undefined);
  const queueOpts = { retryLimit: 5, retryDelay: 5, retryBackoff: true, retryDelayMax: 600, expireInSeconds: 300, deadLetter: QUEUES.deadLetter };
  for (const name of Object.values(QUEUES)) {
    if (name === QUEUES.deadLetter) continue;
    await boss.createQueue(name, queueOpts).catch(() => undefined); // exists
  }

  const enqueue: Enqueue = async (name, data, opts = {}) => {
    await boss.send(name, data as object, {
      ...(opts.singletonKey ? { singletonKey: opts.singletonKey, singletonSeconds: 10 } : {}),
      ...(opts.startAfter !== undefined ? { startAfter: opts.startAfter } : {}),
    });
  };
  const h = createHandlers(pool, enqueue);

  const register = async <K extends keyof JobPayloads>(name: K & QueueName, fn: (data: JobPayloads[K]) => Promise<void>, concurrency = 2) => {
    await boss.work<JobPayloads[K]>(name, { pollingIntervalSeconds: 2, localConcurrency: concurrency }, async (jobs) => {
      for (const job of jobs) {
        const started = Date.now();
        try {
          await fn(job.data);
          log('job.ok', { name, id: job.id, ms: Date.now() - started });
        } catch (err) {
          log('job.error', { name, id: job.id, retry: job.retryCount, error: (err as Error).message });
          throw err; // pg-boss retries with backoff, then dead-letters
        }
      }
    });
  };

  await register(QUEUES.chainIngest, h.chainIngest);
  await register(QUEUES.depositRefresh, h.depositRefresh, 4);
  await register(QUEUES.depositCredit, h.depositCredit, 2);
  await register(QUEUES.depositInvestigate, h.depositInvestigate);
  await register(QUEUES.allocationPost, h.allocationPost, 1);
  await register(QUEUES.correctionPost, h.correctionPost, 1);
  await register(QUEUES.referralRewards, h.referralRewards, 1);
  await register(QUEUES.adjustmentPost, h.adjustmentPost, 1);
  await register(QUEUES.treasurySweep, h.treasurySweep, 1);
  await register(QUEUES.tradesImport, h.tradesImport, 1);
  await register(QUEUES.valuationRun, h.valuationRun, 1);
  await register(QUEUES.withdrawalProcess, h.withdrawalProcess, 2);
  await register(QUEUES.withdrawalMonitor, h.withdrawalMonitor, 2);
  await register(QUEUES.reconciliationRun, h.reconciliationRun, 1);
  await register(QUEUES.notificationsDispatch, h.notificationsDispatch, 1);
  await register(QUEUES.maintenance, h.maintenance, 1);
  await boss.work(QUEUES.deadLetter, async (jobs) => {
    for (const job of jobs) await h.deadLetter({ id: job.id, data: job.data });
  });

  // Scheduler ticks. Overlap is harmless: enqueue uses singleton keys and every handler is idempotent.
  const every = (ms: number, kind: 'fast' | 'medium' | 'slow') => {
    const run = () => h.tick(kind).catch((err) => log('tick.error', { kind, error: (err as Error).message }));
    void run();
    return setInterval(run, ms);
  };
  const timers = [every(10_000, 'fast'), every(5 * 60_000, 'medium'), every(10 * 60_000, 'slow')];
  log('worker.started');

  const shutdown = async () => {
    timers.forEach(clearInterval);
    await boss.stop({ graceful: true, timeout: 20_000 });
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
