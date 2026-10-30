import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { body, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { recordOfflineSubscription } from '@/server/returns/offline';
import { enqueue } from '@/server/jobs/web-queue';

const schema = z.object({ userId: z.uuid(), planId: z.uuid(), amount: z.string().trim().min(1).max(40), reference: z.string().trim().min(5).max(500) });

/** Record principal a member handed the team offline and open the plan for them. Always alerted. */
export const POST = route(async (req) => {
  const staff = await requirePermission('returns.offline');
  const input = await body(req, schema);
  const actor = await requestActor(staff, 'staff');
  const { id } = await withWebTransaction((db) => recordOfflineSubscription(db, { ...input, staffUserId: staff.id, actor }));
  await enqueue('returns.process', {}, 'returns').catch(() => null);
  return json({ id }, { status: 201 });
});
