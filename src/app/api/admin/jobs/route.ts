import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { body, json, route } from '@/server/http/api';
import { webDb } from '@/server/db';
import { many } from '@/server/db-core';
import { enqueue } from '@/server/jobs/web-queue';
import { recordAudit } from '@/server/ops';
import { serverEnv } from '@/server/env';

// A full sync scans the chain and processes everything due, which can take a while.
export const maxDuration = 300;

const schema = z.object({ job: z.enum(['reconciliation', 'valuation', 'trades', 'returns', 'sync']) });

export const POST = route(async (req) => {
  const staff = await requirePermission('jobs.trigger');
  const { job } = await body(req, schema);
  const actor = await requestActor(staff, 'staff');

  if (job === 'sync') {
    if (serverEnv().JOBS_MODE === 'inline') {
      // No worker: run one pass of its whole schedule now.
      const { runAllInline } = await import('@/server/jobs/inline');
      const summary = await runAllInline();
      await recordAudit(webDb(), actor, 'jobs.triggered.sync', undefined, { jobs: summary.jobs, failed: summary.failed.map((f) => f.job) });
      if (summary.failed.length) {
        // Shown on the button. Everything else in the pass completed; failed items stay pending for the next sync.
        // Job names only: raw errors can carry internals (e.g. an RPC URL with its key); details are in the server log.
        const list = [...new Set(summary.failed.map((f) => f.job))].join(', ');
        return json({ error: `${summary.failed.length} of ${summary.jobs} steps failed (${list}). The rest completed; failed items retry on the next sync.`, code: 'sync_partial' }, { status: 422 });
      }
      return json(summary);
    }
    const ids = [await enqueue('returns.process', {}, 'returns'), await enqueue('reconciliation.run', { triggeredBy: `staff:${staff.id}` }, 'reconciliation')];
    await recordAudit(webDb(), actor, 'jobs.triggered.sync', undefined, { jobIds: ids });
    return json({ queued: ids.length }, { status: 202 });
  }

  const ids: (string | null)[] = [];
  if (job === 'reconciliation') ids.push(await enqueue('reconciliation.run', { triggeredBy: `staff:${staff.id}` }, 'reconciliation'));
  else if (job === 'returns') ids.push(await enqueue('returns.process', {}, 'returns'));
  else {
    const pools = await many<{ id: number }>(webDb(), "select id from public.investment_pools where status = 'active'");
    for (const p of pools) {
      if (job === 'trades') ids.push(await enqueue('trades.import', { poolId: Number(p.id) }, `import:${p.id}`));
      else ids.push(await enqueue('valuation.run', { poolId: Number(p.id) }, `valuation:${p.id}`));
    }
  }
  await recordAudit(webDb(), actor, `jobs.triggered.${job}`, undefined, { jobIds: ids });
  return json({ queued: ids.length }, { status: 202 });
});
