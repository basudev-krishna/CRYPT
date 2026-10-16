import { z } from 'zod';
import { requestActor, requireUser } from '@/server/http/auth';
import { body, idempotencyKey, json, rateLimit, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { requestRedemption } from '@/server/investment/orders';
import { parseFixed } from '@/lib/money';

const schema = z.object({ poolId: z.number().int().positive(), units: z.string().regex(/^\d+(\.\d{1,18})?$/).nullable() });

export const POST = route(async (req) => {
  const user = await requireUser();
  await rateLimit(`user:${user.id}:redeem`, 60, 10);
  const input = await body(req, schema);
  const key = idempotencyKey(req);
  const actor = await requestActor(user);
  const id = await withWebTransaction((db) =>
    requestRedemption(db, { userId: user.id, poolId: input.poolId, units: input.units ? parseFixed(input.units) : null, idempotencyKey: `${user.id}:${key}`, actor }),
  );
  return json({ orderId: id }, { status: 201 });
});
