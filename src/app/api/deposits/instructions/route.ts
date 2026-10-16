import { z } from 'zod';
import { requestActor, requireUser } from '@/server/http/auth';
import { ApiError, body, json, rateLimit, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { getDepositInstructions } from '@/server/deposits/service';
import { getProfile } from '@/server/queries/user';
import { custody } from '@/server/web';
import { RISK_DISCLOSURE_VERSION } from '@/lib/disclosures';

const schema = z.object({ networkId: z.number().int().positive() });

export const POST = route(async (req) => {
  const user = await requireUser();
  await rateLimit(`user:${user.id}:deposit-instructions`, 60, 20);
  const { networkId } = await body(req, schema);
  const actor = await requestActor(user);
  const result = await withWebTransaction(async (db) => {
    const profile = await getProfile(db, user.id);
    if (profile?.riskDisclosureVersion !== RISK_DISCLOSURE_VERSION) {
      throw new ApiError('Please review and accept the current risk disclosure first', 403, 'disclosure_required');
    }
    return getDepositInstructions(db, custody(db), user.id, networkId, actor);
  });
  return json(result);
});
