import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { body, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { cancelAllocation } from '@/server/deposits/allocations';

const schema = z.object({ reason: z.string().trim().min(10).max(1000) });

export const POST = route<{ id: string }>(async (req, { params }) => {
  const staff = await requirePermission('deposit.allocate');
  const { reason } = await body(req, schema);
  const allocationId = z.uuid().parse(params.id);
  const actor = await requestActor(staff, 'staff');
  await withWebTransaction((db) => cancelAllocation(db, { allocationId, reason, actor }));
  return json({ ok: true });
});
