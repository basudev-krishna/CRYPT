import { requireUser } from '@/server/http/auth';
import { json, route } from '@/server/http/api';
import { webDb } from '@/server/db';
import { getPositions, listOrders } from '@/server/queries/user';

export const GET = route(async () => {
  const user = await requireUser();
  const [positions, orders] = await Promise.all([getPositions(webDb(), user.id), listOrders(webDb(), user.id)]);
  return json({ positions, orders });
});
