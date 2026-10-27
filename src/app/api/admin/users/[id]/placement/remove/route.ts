import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { body, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { removePlacement } from '@/server/referrals/network';

const schema = z.object({ reason: z.string().trim().min(10).max(1000) });

/** Take this member out of the team tree. Their own team stays attached to them. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const staff = await requirePermission('network.manage');
  const { reason } = await body(req, schema);
  const userId = z.uuid().parse(params.id);
  const actor = await requestActor(staff, 'staff');
  await withWebTransaction((db) => removePlacement(db, { userId, reason, staffUserId: staff.id, actor }));
  return json({ ok: true });
});
