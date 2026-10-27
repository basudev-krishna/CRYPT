import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { body, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { referralPolicySchema } from '@/server/ops';
import { saveReferralPolicy } from '@/server/referrals/rewards';

const schema = z.object({ policy: referralPolicySchema, note: z.string().trim().min(10).max(1000) });

/** Save a new version of the referral reward policy (amount, start date, tiers). */
export const POST = route(async (req) => {
  const staff = await requirePermission('referral.configure');
  const { policy, note } = await body(req, schema);
  const actor = await requestActor(staff, 'staff');
  const { version } = await withWebTransaction((db) => saveReferralPolicy(db, actor, policy, note));
  return json({ version }, { status: 201 });
});
