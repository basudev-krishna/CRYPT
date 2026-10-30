import { z } from 'zod';
import { requestActor, requireUser } from '@/server/http/auth';
import { body, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { cancelSubscription, requestRedemption } from '@/server/returns/service';
import { enqueue } from '@/server/jobs/web-queue';

const schema = z.object({ action: z.enum(['cancel', 'redeem']) });

/** The member cancels their own pending subscription, or asks for their principal back after the lock. */
export const POST = route<{ id: string }>(
  async (req, { params }) => {
    const user = await requireUser();
    const { action } = await body(req, schema);
    const subscriptionId = z.uuid().parse(params.id);
    const actor = await requestActor(user);
    await withWebTransaction((db) =>
      action === 'cancel' ? cancelSubscription(db, { userId: user.id, subscriptionId, actor }) : requestRedemption(db, { userId: user.id, subscriptionId, actor }),
    );
    if (action === 'redeem') await enqueue('returns.process', {}, 'returns').catch(() => null);
    return json({ ok: true });
  },
  { limit: 30, windowSeconds: 60 },
);
