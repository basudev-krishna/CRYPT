import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { body, idempotencyKey, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { setBalance, startHolderForUser } from '@/server/offchain/holdings';

const amount = z.string().trim().min(1).max(40);
const schema = z.object({ target: amount, expected: amount, occurredOn: z.iso.date(), reason: z.string().trim().max(1000).optional() });

/** Set the member's balance held with the administrator to a new total; the difference is recorded as one entry. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const staff = await requirePermission('offchain.record');
  const key = idempotencyKey(req);
  const input = await body(req, schema);
  const userId = z.uuid().parse(params.id);
  const actor = await requestActor(staff, 'staff');
  const { id } = await withWebTransaction(async (db) => {
    const holder = await startHolderForUser(db, { userId, staffUserId: staff.id, actor });
    return setBalance(db, { ...input, holderId: holder.id, idempotencyKey: `entry:${key}`, staffUserId: staff.id, actor });
  });
  return json({ id }, { status: 201 });
});
