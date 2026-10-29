import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { body, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { memberDetailsSchema, updateMemberDetails } from '@/server/admin-members';

/** Correct a member's name, username (sign-in alias), phone or country. Audited with before/after values. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const staff = await requirePermission('member.edit');
  const details = await body(req, memberDetailsSchema);
  const userId = z.uuid().parse(params.id);
  const actor = await requestActor(staff, 'staff');
  await withWebTransaction((db) => updateMemberDetails(db, { userId, details, actor }));
  return json({ ok: true });
});
