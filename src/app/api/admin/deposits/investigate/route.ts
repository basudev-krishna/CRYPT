import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { body, json, route } from '@/server/http/api';
import { webDb } from '@/server/db';
import { enqueue } from '@/server/jobs/web-queue';
import { recordAudit } from '@/server/ops';

const schema = z.object({ networkId: z.number().int().positive(), txHash: z.string().trim().min(10).max(100) });

/** Queue an on-chain lookup of a reported transaction (missing / unsupported deposits). */
export const POST = route(async (req) => {
  const staff = await requirePermission('deposit.investigate');
  const input = await body(req, schema);
  await recordAudit(webDb(), await requestActor(staff, 'staff'), 'deposit.investigation_requested', { type: 'tx', id: input.txHash }, { networkId: input.networkId });
  const jobId = await enqueue('deposit.investigate', { ...input, requestedBy: staff.id });
  return json({ queued: true, jobId }, { status: 202 });
});
