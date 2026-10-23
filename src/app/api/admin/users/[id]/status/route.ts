import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { ApiError, body, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { notify, recordAudit } from '@/server/ops';

const schema = z.object({ status: z.enum(['active', 'restricted', 'frozen']), reason: z.string().trim().min(10).max(500) });

/** Documented account restrictions. Balances are never edited here. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const staff = await requirePermission('user.restrict');
  const { status, reason } = await body(req, schema);
  if (params.id === staff.id) throw new ApiError('Staff cannot change their own account status', 403, 'conflict_of_interest');
  const actor = await requestActor(staff, 'staff');
  await withWebTransaction(async (db) => {
    // Sign-ups still awaiting (or refused) approval go through the approval action instead.
    const res = await db.query(
      "update public.user_profiles set account_status = $2, restriction_reason = $3 where user_id = $1 and account_status not in ('pending_approval', 'rejected')",
      [params.id, status, status === 'active' ? null : reason],
    );
    if (res.rowCount !== 1) throw new ApiError('User not found, or still awaiting sign-up approval', 404, 'not_found');
    await recordAudit(db, actor, `user.status.${status}`, { type: 'user', id: params.id }, { reason });
    await notify(db, { userId: params.id, kind: 'account_status_changed', payload: { status } });
  });
  return json({ ok: true });
});
