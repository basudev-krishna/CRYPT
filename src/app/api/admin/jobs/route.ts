import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { body, json, route } from '@/server/http/api';
import { webDb } from '@/server/db';
import { many } from '@/server/db-core';
import { enqueue } from '@/server/jobs/web-queue';
import { recordAudit } from '@/server/ops';

const schema = z.object({ job: z.enum(['reconciliation', 'valuation', 'trades', 'returns']) });

export const POST = route(async (req) => {
  const staff = await requirePermission('jobs.trigger');
  const { job } = await body(req, schema);
  const actor = await requestActor(staff, 'staff');
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
