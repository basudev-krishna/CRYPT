import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { body, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { reverseAdjustment } from '@/server/adjustments/manual';
import { enqueue } from '@/server/jobs/web-queue';

const schema = z.object({ reason: z.string().trim().min(10).max(1000) });

/** Undo a posted adjustment with the opposite one (once). */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const staff = await requirePermission('balance.adjust');
  const { reason } = await body(req, schema);
  const adjustmentId = z.uuid().parse(params.id);
  const actor = await requestActor(staff, 'staff');
  const { id } = await withWebTransaction((db) => reverseAdjustment(db, { adjustmentId, reason, staffUserId: staff.id, actor }));
  await enqueue('adjustment.post', { adjustmentId: id }, `adjustment:${id}`).catch(() => null);
  return json({ id }, { status: 201 });
});
