import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { body, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { correctRank } from '@/server/referrals/program';

/** `change` is "revoke:E2" or "grant:E2". */
const schema = z.object({
  change: z.string().regex(/^(revoke|grant):[A-Za-z0-9]{1,12}$/),
  reason: z.string().trim().min(10).max(1000),
});

/** Revoke a rank a member holds, or grant one they do not. Appended, audited and alerted. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const staff = await requirePermission('network.manage');
  const { change, reason } = await body(req, schema);
  const userId = z.uuid().parse(params.id);
  const [action, rankCode] = change.split(':') as ['revoke' | 'grant', string];
  const actor = await requestActor(staff, 'staff');
  await withWebTransaction((db) => correctRank(db, { userId, rankCode, action, reason, staffUserId: staff.id, actor }));
  return json({ ok: true });
});
