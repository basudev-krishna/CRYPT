import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { ApiError, body, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { recordAudit } from '@/server/ops';

const schema = z.object({ status: z.enum(['acknowledged', 'resolved']), note: z.string().trim().min(10).max(1000) });

export const POST = route<{ id: string }>(async (req, { params }) => {
  const staff = await requirePermission('risk.resolve');
  const { status, note } = await body(req, schema);
  const actor = await requestActor(staff, 'staff');
  await withWebTransaction(async (db) => {
    const res = await db.query(
      "update public.risk_events set status = $2, resolution_note = $3, resolved_by = $4, resolved_at = case when $2::text = 'resolved' then now() end where id = $1 and status <> 'resolved'",
      [params.id, status, note, staff.id],
    );
    if (res.rowCount !== 1) throw new ApiError('Not found or already resolved', 404, 'not_found');
    await recordAudit(db, actor, `risk.${status}`, { type: 'risk_event', id: params.id }, { note });
  });
  return json({ ok: true });
});
