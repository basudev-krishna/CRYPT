import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { body, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { createAdjustment } from '@/server/adjustments/manual';
import { enqueue } from '@/server/jobs/web-queue';

const schema = z.object({
  tokenId: z.number().int().positive(),
  direction: z.enum(['credit', 'debit']),
  fund: z.enum(['operator_float', 'referral_reward_fund']).default('operator_float'),
  amount: z.string().trim().min(1).max(40),
  reason: z.string().trim().min(10).max(1000),
});

/** Credit or debit a member against the operator float. The worker posts it. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const staff = await requirePermission('balance.adjust');
  const input = await body(req, schema);
  const userId = z.uuid().parse(params.id);
  const actor = await requestActor(staff, 'staff');
  const { id } = await withWebTransaction((db) => createAdjustment(db, { ...input, userId, staffUserId: staff.id, actor }));
  // The scheduler also picks up pending adjustments, so a failed enqueue only delays it.
  await enqueue('adjustment.post', { adjustmentId: id }, `adjustment:${id}`).catch(() => null);
  return json({ id }, { status: 201 });
});
