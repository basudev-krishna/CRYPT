import { z } from 'zod';
import { requestActor, requireUser } from '@/server/http/auth';
import { body, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { claimReferralReward } from '@/server/referrals/rewards';
import { claimProgramReward } from '@/server/referrals/program';

const schema = z.object({ kind: z.enum(['referral', 'program']), rewardId: z.uuid() });

/** The signed-in member claims one of their own recorded rewards; it is paid after approval. Safe to repeat. */
export const POST = route(
  async (req) => {
    const user = await requireUser();
    const { kind, rewardId } = await body(req, schema);
    const actor = await requestActor(user);
    await withWebTransaction((db) =>
      kind === 'referral' ? claimReferralReward(db, { userId: user.id, rewardId, actor }) : claimProgramReward(db, { userId: user.id, rewardId, actor }),
    );
    return json({ ok: true });
  },
  { limit: 30, windowSeconds: 60 },
);
