import { requestActor, requireUser } from '@/server/http/auth';
import { json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { cancelWithdrawal } from '@/server/withdrawals/service';

export const POST = route<{ id: string }>(async (_req, { params }) => {
  const user = await requireUser();
  const actor = await requestActor(user);
  await withWebTransaction((db) => cancelWithdrawal(db, { userId: user.id, withdrawalId: params.id, actor }));
  return json({ ok: true });
});
