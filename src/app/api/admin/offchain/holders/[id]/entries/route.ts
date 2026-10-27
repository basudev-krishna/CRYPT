import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { body, idempotencyKey, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { recordEntry } from '@/server/offchain/holdings';

const schema = z.object({
  kind: z.enum(['contribution', 'earnings', 'payback', 'adjustment']),
  amount: z.string().trim().min(1).max(40),
  occurredOn: z.iso.date(),
  reason: z.string().trim().min(10).max(1000),
});

/** Add an off-platform ledger entry. Idempotent per Idempotency-Key, so a double submit records it once. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const staff = await requirePermission('offchain.record');
  const key = idempotencyKey(req);
  const input = await body(req, schema);
  const holderId = z.uuid().parse(params.id);
  const actor = await requestActor(staff, 'staff');
  const { id } = await withWebTransaction((db) => recordEntry(db, { ...input, holderId, idempotencyKey: `entry:${key}`, staffUserId: staff.id, actor }));
  return json({ id }, { status: 201 });
});
