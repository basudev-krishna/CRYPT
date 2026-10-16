import { z } from 'zod';
import { requestActor, requireUser } from '@/server/http/auth';
import { body, json, rateLimit, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { confirmWithdrawal } from '@/server/withdrawals/service';

const schema = z.object({ withdrawalId: z.uuid() });

/**
 * Step-up confirmation. "mfaVerified" is derived from the server-validated
 * session assurance level (AAL2), never from the request body.
 */
export const POST = route(async (req) => {
  const user = await requireUser();
  await rateLimit(`user:${user.id}:withdraw-confirm`, 600, 10);
  const { withdrawalId } = await body(req, schema);
  const actor = await requestActor(user);
  const result = await withWebTransaction((db) => confirmWithdrawal(db, { userId: user.id, withdrawalId, mfaVerified: user.aal === 'aal2', actor }));
  // The worker picks up reserved withdrawals on its next tick; no client-triggered payout.
  return json(result);
});
