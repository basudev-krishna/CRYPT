import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { body, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { correctSponsor } from '@/server/referrals/network';

const schema = z.object({
  sponsorMemberCode: z.string().trim().regex(/^EW-[0-9]{6,}$/i, 'Member ids look like EW-000123').nullable(),
  reason: z.string().trim().min(10).max(1000),
});

/** Change (or clear) who referred this member. Audited with the previous value. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const staff = await requirePermission('network.manage');
  const { sponsorMemberCode, reason } = await body(req, schema);
  const userId = z.uuid().parse(params.id);
  const actor = await requestActor(staff, 'staff');
  await withWebTransaction((db) => correctSponsor(db, { userId, sponsorMemberCode, reason, staffUserId: staff.id, actor }));
  return json({ ok: true });
});
