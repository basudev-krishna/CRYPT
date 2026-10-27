import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { body, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { createAllocation } from '@/server/deposits/allocations';
import { enqueue } from '@/server/jobs/web-queue';

const schema = z.object({
  depositId: z.uuid(),
  kind: z.enum(['assignment', 'distribution', 'referral_fund', 'operator_float']),
  reason: z.string().trim().min(10).max(1000),
  lines: z.array(z.object({ userId: z.uuid(), amount: z.string().trim().max(40) })).max(200),
});

/** Assign an unattributed group-wallet receipt to a member, split it as a distribution, or add it to the referral reward fund. The worker posts it. */
export const POST = route(async (req) => {
  const staff = await requirePermission('deposit.allocate');
  const input = await body(req, schema);
  const actor = await requestActor(staff, 'staff');
  const { id } = await withWebTransaction((db) => createAllocation(db, { ...input, staffUserId: staff.id, actor }));
  // The worker's scheduler also picks up pending allocations, so a failed enqueue only delays it.
  await enqueue('allocation.post', { allocationId: id }, `allocation:${id}`).catch(() => null);
  return json({ id }, { status: 201 });
});
