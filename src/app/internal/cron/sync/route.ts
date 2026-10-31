import { timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { ApiError, json, route } from '@/server/http/api';
import { webDb } from '@/server/db';
import { recordAudit } from '@/server/ops';
import { serverEnv } from '@/server/env';

// One pass scans the chain and processes everything due, which can take a while.
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/** Bearer CRON_SECRET, compared in constant time. Fails closed when the secret is unset. */
function assertCron(req: NextRequest): void {
  const secret = serverEnv().CRON_SECRET;
  const given = Buffer.from(req.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${secret ?? ''}`);
  if (!secret || given.length !== expected.length || !timingSafeEqual(given, expected)) throw new ApiError('Unauthorized', 401, 'unauthorized');
}

/**
 * Scheduled sync without a worker (JOBS_MODE=inline): the same pass as the
 * admin's "Sync & process now", so deposits are credited and daily returns are
 * enrolled, accrued and settled with nobody at the console. Called by Vercel
 * Cron and the scheduled GitHub workflow. Every step is idempotent, so
 * overlapping or repeated calls are harmless.
 */
async function sync(req: NextRequest) {
  assertCron(req);
  if (serverEnv().JOBS_MODE !== 'inline') throw new ApiError('Scheduled sync runs only with JOBS_MODE=inline; the worker runs the schedule', 409, 'worker_mode');
  const { runAllInline } = await import('@/server/jobs/inline');
  const summary = await runAllInline();
  const failed = [...new Set(summary.failed.map((f) => f.job))];
  await recordAudit(webDb(), { type: 'system', id: 'cron' }, 'jobs.triggered.sync', undefined, { jobs: summary.jobs, failed });
  // Job names only: raw errors can carry internals; details are in the server log.
  return json({ jobs: summary.jobs, failed }, { status: failed.length ? 207 : 200 });
}

export const GET = route(sync, { skipOriginCheck: true, limit: 30 });
export const POST = route(sync, { skipOriginCheck: true, limit: 30 });
