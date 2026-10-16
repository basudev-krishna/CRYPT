import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { body, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { setComplianceHold } from '@/server/withdrawals/service';

const schema = z.object({ hold: z.boolean(), note: z.string().trim().min(10).max(1000) });

export const POST = route<{ id: string }>(async (req, { params }) => {
  const staff = await requirePermission('withdrawal.hold');
  const { hold, note } = await body(req, schema);
  const actor = await requestActor(staff, 'staff');
  await withWebTransaction((db) => setComplianceHold(db, { withdrawalId: params.id, hold, note, actor }));
  return json({ ok: true });
});
