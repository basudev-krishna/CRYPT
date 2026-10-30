import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { body, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { activatePlan, closePlan } from '@/server/returns/service';

const schema = z.object({ action: z.enum(['activate', 'close']), note: z.string().trim().min(10).max(1000) });

/** Activate a draft plan (a different administrator from its creator, unless sole admin: alerted) or close it to new subscriptions. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const staff = await requirePermission('returns.configure');
  const { action, note } = await body(req, schema);
  const planId = z.uuid().parse(params.id);
  const actor = await requestActor(staff, 'staff');
  await withWebTransaction((db) =>
    action === 'activate' ? activatePlan(db, { planId, note, staffUserId: staff.id, actor }) : closePlan(db, { planId, note, staffUserId: staff.id, actor }),
  );
  return json({ ok: true });
});
