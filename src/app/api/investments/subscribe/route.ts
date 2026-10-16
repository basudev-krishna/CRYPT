import { z } from 'zod';
import { requestActor, requireUser } from '@/server/http/auth';
import { ApiError, body, idempotencyKey, json, rateLimit, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { getPool, requestSubscription } from '@/server/investment/orders';
import { getToken } from '@/server/chains/registry';
import { parseUnits } from '@/lib/money';

const schema = z.object({ poolId: z.number().int().positive(), amount: z.string().max(40) });

export const POST = route(async (req) => {
  const user = await requireUser();
  await rateLimit(`user:${user.id}:subscribe`, 60, 10);
  const input = await body(req, schema);
  const key = idempotencyKey(req);
  const actor = await requestActor(user);
  const id = await withWebTransaction(async (db) => {
    const pool = await getPool(db, input.poolId);
    const token = await getToken(db, pool.tokenId);
    const amount = parseUnits(input.amount, token.decimals);
    if (amount <= 0n) throw new ApiError('Amount must be positive', 400, 'invalid_amount');
    return requestSubscription(db, { userId: user.id, poolId: pool.id, tokenId: token.id, amount, idempotencyKey: `${user.id}:${key}`, actor });
  });
  return json({ orderId: id }, { status: 201 });
});
