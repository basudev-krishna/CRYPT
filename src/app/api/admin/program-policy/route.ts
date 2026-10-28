import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { body, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { rewardsProgramSchema } from '@/server/ops';
import { saveProgramPolicy } from '@/server/referrals/program';

const schema = z.object({ policy: rewardsProgramSchema, note: z.string().trim().min(10).max(1000) });

/** Save a new version of the matching, rank and placement program. */
export const POST = route(async (req) => {
  const staff = await requirePermission('referral.configure');
  const { policy, note } = await body(req, schema);
  const actor = await requestActor(staff, 'staff');
  const { version } = await withWebTransaction((db) => saveProgramPolicy(db, actor, policy, note));
  return json({ version }, { status: 201 });
});
