import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { body, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { reviewProgramReward } from '@/server/referrals/program';
import { enqueue } from '@/server/jobs/web-queue';

const schema = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().trim().min(10).max(1000) });

/** Approve (reserving pool funds) or reject a pending matching or rank reward. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const staff = await requirePermission('referral.review');
  const { decision, note } = await body(req, schema);
  const rewardId = z.uuid().parse(params.id);
  const actor = await requestActor(staff, 'staff');
  await withWebTransaction((db) => reviewProgramReward(db, { rewardId, decision, note, staffUserId: staff.id, actor }));
  // The scheduler also runs this job, so a failed enqueue only delays payment.
  if (decision === 'approve') await enqueue('referral.rewards', {}, 'referral-rewards').catch(() => null);
  return json({ ok: true });
});
