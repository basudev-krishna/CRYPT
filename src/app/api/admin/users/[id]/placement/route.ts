import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { body, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { setPlacement } from '@/server/referrals/network';

const schema = z.object({
  parentMemberCode: z.string().trim().regex(/^EW-[0-9]{6,}$/i, 'Member ids look like EW-000123'),
  side: z.enum(['left', 'right']),
  reason: z.string().trim().min(10).max(1000),
});

/** Place or move this member (with their team) to the left or right of a parent. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const staff = await requirePermission('network.manage');
  const input = await body(req, schema);
  const userId = z.uuid().parse(params.id);
  const actor = await requestActor(staff, 'staff');
  await withWebTransaction((db) => setPlacement(db, { ...input, userId, staffUserId: staff.id, actor }));
  return json({ ok: true });
});
