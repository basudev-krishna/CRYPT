/**
 * Staff role management from the admin console. Roles are the permission
 * matrix's input (permissions.ts), so every grant and revocation is audited and
 * alerted. The last administrator can never be removed, so the console can't
 * be locked out.
 */
import { maybeOne, one, type Db } from './db-core';
import { raiseRiskEvent, recordAudit, type Actor } from './ops';
import type { StaffRole } from './permissions';

export class StaffError extends Error {
  override name = 'StaffError';
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export const STAFF_ROLES: readonly StaffRole[] = ['admin', 'operations', 'compliance', 'read_only'];
const MIN_NOTE = 10;

export async function changeStaffRole(
  db: Db,
  args: { userId: string; role: StaffRole; action: 'grant' | 'revoke'; note: string; staffUserId: string; actor: Actor },
): Promise<void> {
  const note = args.note.trim();
  if (note.length < MIN_NOTE) throw new StaffError(`A note of at least ${MIN_NOTE} characters is required`, 'note_required');
  const profile = await maybeOne<{ account_status: string; email: string }>(db, 'select account_status, email from public.user_profiles where user_id = $1', [args.userId]);
  if (!profile) throw new StaffError('Member not found', 'not_found');
  // Serialize role changes so two admins can't remove each other at the same moment.
  await db.query("select pg_advisory_xact_lock(hashtext('staff_roles'))");

  if (args.action === 'grant') {
    if (profile.account_status !== 'active') throw new StaffError('Only an active member can be given a staff role', 'member_not_active');
    const res = await db.query('insert into public.staff_roles (user_id, role, granted_by) values ($1, $2, $3) on conflict do nothing', [
      args.userId,
      args.role,
      args.staffUserId,
    ]);
    if (res.rowCount !== 1) throw new StaffError(`This member already has the ${args.role} role`, 'already_granted');
  } else {
    if (args.role === 'admin') {
      const admins = await one<{ n: number }>(db, "select count(*)::int as n from public.staff_roles where role = 'admin'");
      if (admins.n <= 1) throw new StaffError('The last administrator cannot be removed; add another administrator first', 'last_admin');
    }
    const res = await db.query('delete from public.staff_roles where user_id = $1 and role = $2', [args.userId, args.role]);
    if (res.rowCount !== 1) throw new StaffError(`This member does not have the ${args.role} role`, 'not_granted');
  }

  const details = { role: args.role, email: profile.email, note, self: args.userId === args.staffUserId };
  await recordAudit(db, args.actor, args.action === 'grant' ? 'staff.role_granted' : 'staff.role_revoked', { type: 'user', id: args.userId }, details);
  await raiseRiskEvent(db, {
    userId: args.userId,
    kind: args.action === 'grant' ? 'staff_role_granted' : 'staff_role_revoked',
    severity: 'high',
    subjectType: 'user',
    subjectId: args.userId,
    details,
  });
}
