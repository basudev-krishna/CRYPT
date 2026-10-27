import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { body, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { changeStaffRole, STAFF_ROLES } from '@/server/staff';

// One field so the console's single-choice action can send it: "grant:admin", "revoke:operations", ...
const schema = z.object({
  change: z.string().regex(new RegExp(`^(grant|revoke):(${STAFF_ROLES.join('|')})$`), 'Choose a role change'),
  note: z.string().trim().min(10).max(1000),
});

/** Grant or revoke a staff role for this member. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const staff = await requirePermission('staff.manage');
  const { change, note } = await body(req, schema);
  const userId = z.uuid().parse(params.id);
  const [action, role] = change.split(':') as ['grant' | 'revoke', (typeof STAFF_ROLES)[number]];
  const actor = await requestActor(staff, 'staff');
  await withWebTransaction((db) => changeStaffRole(db, { userId, role, action, note, staffUserId: staff.id, actor }));
  return json({ ok: true });
});
