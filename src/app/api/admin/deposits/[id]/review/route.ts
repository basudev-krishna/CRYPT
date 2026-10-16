import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { body, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { reviewDeposit } from '@/server/deposits/service';

const schema = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().trim().min(10).max(1000) });

export const POST = route<{ id: string }>(async (req, { params }) => {
  const staff = await requirePermission('deposit.review');
  const { decision, note } = await body(req, schema);
  const actor = await requestActor(staff, 'staff');
  await withWebTransaction((db) => reviewDeposit(db, params.id, decision, note, actor));
  return json({ ok: true });
});
