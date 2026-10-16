import { z } from 'zod';
import { json, route } from '@/server/http/api';
import { verifyInternal } from '@/server/http/internal';
import { enqueue } from '@/server/jobs/web-queue';

const schema = z.object({ networkId: z.number().int().positive() });

/** Service-authenticated (HMAC). Enqueues durable work for the worker; never runs it inline. */
export const POST = route(
  async (req) => {
    const raw = await verifyInternal(req);
    const input = schema.parse(raw ? JSON.parse(raw) : {});
    const jobId = await enqueue('chain.ingest', { networkId: input.networkId }, `ingest:${input.networkId}`);
    return json({ queued: true, jobId }, { status: 202 });
  },
  { skipOriginCheck: true, limit: 600 },
);
