import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { body, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { cancelAdjustment } from '@/server/adjustments/manual';

const schema = z.object({ reason: z.string().trim().min(10).max(1000) });

/** Cancel an adjustment that has not been posted yet. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const staff = await requirePermission('balance.adjust');
  const { reason } = await body(req, schema);
  const adjustmentId = z.uuid().parse(params.id);
  const actor = await requestActor(staff, 'staff');
  await withWebTransaction((db) => cancelAdjustment(db, { adjustmentId, reason, actor }));
  return json({ ok: true });
});
