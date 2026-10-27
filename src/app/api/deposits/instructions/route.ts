import { z } from 'zod';
import { requestActor, requireUser } from '@/server/http/auth';
import { body, json, rateLimit, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { getDepositInstructions } from '@/server/deposits/service';
import { custody } from '@/server/web';

const schema = z.object({ networkId: z.number().int().positive() });

export const POST = route(async (req) => {
  const user = await requireUser();
  await rateLimit(`user:${user.id}:deposit-instructions`, 60, 20);
  const { networkId } = await body(req, schema);
  const actor = await requestActor(user);
  const result = await withWebTransaction((db) => getDepositInstructions(db, custody(db), user.id, networkId, actor));
  return json(result);
});
