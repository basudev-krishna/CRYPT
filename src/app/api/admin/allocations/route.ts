import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { body, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { createAllocation } from '@/server/deposits/allocations';
import { enqueue } from '@/server/jobs/web-queue';

const schema = z.object({
  depositId: z.uuid(),
  kind: z.enum(['assignment', 'distribution', 'referral_fund', 'operator_float', 'business_revenue']),
  reason: z.string().trim().min(10).max(1000),
  lines: z.array(z.object({ userId: z.uuid(), amount: z.string().trim().max(40) })).max(200),
  revenue: z
    .object({
      businessLine: z.string().trim().min(3).max(120),
      periodStart: z.iso.date(),
      periodEnd: z.iso.date(),
      evidenceReference: z.string().trim().min(5).max(500),
    })
    .optional(),
});

/** Assign an unattributed group-wallet receipt to a member, split it as a distribution, add it to an operator fund, or record it as business revenue for daily returns. The worker posts it. */
export const POST = route(async (req) => {
  const staff = await requirePermission('deposit.allocate');
  const input = await body(req, schema);
  const actor = await requestActor(staff, 'staff');
  const { id } = await withWebTransaction((db) => createAllocation(db, { ...input, staffUserId: staff.id, actor }));
  // The worker's scheduler also picks up pending allocations, so a failed enqueue only delays it.
  await enqueue('allocation.post', { allocationId: id }, `allocation:${id}`).catch(() => null);
  return json({ id }, { status: 201 });
});
