import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { body, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { reviewReferralReward } from '@/server/referrals/rewards';
import { enqueue } from '@/server/jobs/web-queue';

const schema = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().trim().min(10).max(1000) });

/** Approve or reject a pending referral reward. Approved rewards are paid from the fund by the worker. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const staff = await requirePermission('referral.review');
  const { decision, note } = await body(req, schema);
  const rewardId = z.uuid().parse(params.id);
  const actor = await requestActor(staff, 'staff');
  await withWebTransaction((db) => reviewReferralReward(db, { rewardId, decision, note, staffUserId: staff.id, actor }));
  // The scheduler also runs this job, so a failed enqueue only delays payment.
  if (decision === 'approve') await enqueue('referral.rewards', {}, 'referral-rewards').catch(() => null);
  return json({ ok: true });
});
