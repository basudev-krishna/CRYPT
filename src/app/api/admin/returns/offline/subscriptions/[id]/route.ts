import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { body, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { requestOfflineRedemption } from '@/server/returns/offline';
import { enqueue } from '@/server/jobs/web-queue';

const schema = z.object({ note: z.string().trim().min(10).max(1000) });

/** Record that a member's offline principal is being returned offline. Accrual stops today. Always alerted. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const staff = await requirePermission('returns.offline');
  const { note } = await body(req, schema);
  const subscriptionId = z.uuid().parse(params.id);
  const actor = await requestActor(staff, 'staff');
  await withWebTransaction((db) => requestOfflineRedemption(db, { subscriptionId, note, staffUserId: staff.id, actor }));
  await enqueue('returns.process', {}, 'returns').catch(() => null);
  return json({ ok: true });
});
