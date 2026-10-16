import { requestActor, requireUser } from '@/server/http/auth';
import { json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { cancelOrder } from '@/server/investment/orders';

export const POST = route<{ id: string }>(async (_req, { params }) => {
  const user = await requireUser();
  const actor = await requestActor(user);
  await withWebTransaction((db) => cancelOrder(db, { userId: user.id, orderId: params.id, actor }));
  return json({ ok: true });
});
