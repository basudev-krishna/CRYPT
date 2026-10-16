import { z } from 'zod';
import { requestActor, requireUser } from '@/server/http/auth';
import { body, idempotencyKey, json, rateLimit, route } from '@/server/http/api';
import { webDb, withWebTransaction } from '@/server/db';
import { createWithdrawal } from '@/server/withdrawals/service';
import { listWithdrawals } from '@/server/queries/user';
import { adapterForNetwork } from '@/server/web';

const schema = z.object({
  networkId: z.number().int().positive(),
  destination: z.string().trim().min(10).max(100),
  amount: z.string().trim().max(40),
});

export const GET = route(async () => {
  const user = await requireUser();
  return json({ items: await listWithdrawals(webDb(), user.id) });
});

export const POST = route(async (req) => {
  const user = await requireUser();
  await rateLimit(`user:${user.id}:withdraw`, 3600, 10);
  const input = await body(req, schema);
  const key = idempotencyKey(req);
  const actor = await requestActor(user);
  const result = await withWebTransaction(async (db) =>
    createWithdrawal(db, await adapterForNetwork(input.networkId, db), { userId: user.id, networkId: input.networkId, destination: input.destination, amount: input.amount, idempotencyKey: key, actor }),
  );
  return json(result, { status: result.replayed ? 200 : 201 });
});
