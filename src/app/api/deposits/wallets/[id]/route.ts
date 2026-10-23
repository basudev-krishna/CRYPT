import { requestActor, requireUser } from '@/server/http/auth';
import { ApiError, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { removeMemberWallet } from '@/server/deposits/member-wallets';

/** Stop crediting future deposits from this wallet to the caller. */
export const DELETE = route<{ id: string }>(async (_req, { params }) => {
  const user = await requireUser();
  if (!/^[0-9a-f-]{36}$/i.test(params.id)) throw new ApiError('Wallet not found', 404, 'not_found');
  const actor = await requestActor(user);
  await withWebTransaction((db) => removeMemberWallet(db, { userId: user.id, walletId: params.id, actor }));
  return json({ ok: true });
});
