import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { body, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { decideSignup } from '@/server/approvals';

const schema = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().trim().min(10).max(500) });

/** Approve or reject a new sign-up. Documented, audited, never self-reviewed. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const staff = await requirePermission('user.approve');
  const { decision, note } = await body(req, schema);
  const actor = await requestActor(staff, 'staff');
  const result = await withWebTransaction((db) => decideSignup(db, actor, { userId: params.id, decision, note }));
  return json(result);
});
