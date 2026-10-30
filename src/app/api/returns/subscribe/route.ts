import { z } from 'zod';
import { requestActor, requireUser } from '@/server/http/auth';
import { body, idempotencyKey, json, rateLimit, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { requestSubscription } from '@/server/returns/service';
import { enqueue } from '@/server/jobs/web-queue';

const schema = z.object({ planId: z.uuid(), amount: z.string().trim().min(1).max(40) });

/** Commit available balance to a daily-return plan. The worker moves it under the balance lock. Safe to retry with the same key. */
export const POST = route(async (req) => {
  const user = await requireUser();
  await rateLimit(`user:${user.id}:returns-subscribe`, 60, 10);
  const input = await body(req, schema);
  const clientKey = idempotencyKey(req);
  const actor = await requestActor(user);
  const { id } = await withWebTransaction((db) => requestSubscription(db, { userId: user.id, planId: input.planId, amount: input.amount, clientKey, actor }));
  // The worker's scheduler also picks up pending subscriptions, so a failed enqueue only delays it.
  await enqueue('returns.process', {}, 'returns').catch(() => null);
  return json({ id }, { status: 201 });
});
