import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { body, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { reverseEntry } from '@/server/offchain/holdings';

const schema = z.object({ reason: z.string().trim().min(10).max(1000) });

/** Correct a mistaken off-platform entry by reversing it. Each entry can be reversed once. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const staff = await requirePermission('offchain.record');
  const { reason } = await body(req, schema);
  const entryId = z.string().regex(/^\d{1,18}$/).parse(params.id);
  const actor = await requestActor(staff, 'staff');
  const { id } = await withWebTransaction((db) => reverseEntry(db, { entryId, reason, idempotencyKey: `reverse:${entryId}`, staffUserId: staff.id, actor }));
  return json({ id }, { status: 201 });
});
