import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { body, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { createCorrection } from '@/server/deposits/allocations';
import { enqueue } from '@/server/jobs/web-queue';

const schema = z.object({ reason: z.string().trim().min(10).max(1000) });

/** Reverse a credited deposit back into suspense so it can be allocated again. The worker posts the reversal. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const staff = await requirePermission('deposit.allocate');
  const { reason } = await body(req, schema);
  const depositId = z.uuid().parse(params.id);
  const actor = await requestActor(staff, 'staff');
  const { id } = await withWebTransaction((db) => createCorrection(db, { depositId, reason, staffUserId: staff.id, actor }));
  await enqueue('correction.post', { correctionId: id }, `correction:${id}`).catch(() => null);
  return json({ id }, { status: 201 });
});
