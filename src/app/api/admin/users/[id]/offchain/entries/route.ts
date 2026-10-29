import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { body, idempotencyKey, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { recordEntry, startHolderForUser } from '@/server/offchain/holdings';

const schema = z.object({
  kind: z.enum(['contribution', 'earnings', 'payback', 'adjustment']),
  category: z.enum(['matching_bonus']).nullable().optional(),
  amount: z.string().trim().min(1).max(40),
  occurredOn: z.iso.date(),
  reason: z.string().trim().min(10).max(1000),
});

/**
 * Record money settled with a member personally (paid in, a prize or earnings,
 * paid back) straight from their user page, opening their off-platform record
 * if needed. Idempotent per Idempotency-Key.
 */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const staff = await requirePermission('offchain.record');
  const key = idempotencyKey(req);
  const input = await body(req, schema);
  const userId = z.uuid().parse(params.id);
  const actor = await requestActor(staff, 'staff');
  const { id } = await withWebTransaction(async (db) => {
    const holder = await startHolderForUser(db, { userId, staffUserId: staff.id, actor });
    return recordEntry(db, { ...input, holderId: holder.id, idempotencyKey: `entry:${key}`, staffUserId: staff.id, actor });
  });
  return json({ id }, { status: 201 });
});
