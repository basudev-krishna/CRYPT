import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { ApiError, body, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { revokeInvitation } from '@/server/membership';

const schema = z.object({ reason: z.string().trim().min(10).max(500) });

export const POST = route<{ id: string }>(async (req, { params }) => {
  const staff = await requirePermission('member.invite');
  if (!z.uuid().safeParse(params.id).success) throw new ApiError('Not found', 404, 'not_found');
  const { reason } = await body(req, schema);
  const actor = await requestActor(staff, 'staff');
  await withWebTransaction((db) => revokeInvitation(db, actor, params.id, reason));
  return json({ ok: true });
});
