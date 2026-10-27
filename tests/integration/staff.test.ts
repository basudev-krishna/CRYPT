/** Staff role management from the admin console. */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { admin, closePools, createUser, resetAppData, web } from '../helpers/db';
import { withTransaction } from '../../src/server/db-core';
import { changeStaffRole } from '../../src/server/staff';
import type { StaffRole } from '../../src/server/permissions';

let adminId: string;
beforeEach(async () => {
  await resetAppData();
  adminId = await createUser();
  await admin.query("insert into public.staff_roles (user_id, role) values ($1, 'admin')", [adminId]);
});
afterAll(closePools);

const change = (userId: string, role: StaffRole, action: 'grant' | 'revoke') =>
  withTransaction(web, (db) => changeStaffRole(db, { userId, role, action, note: 'Agreed in the group chat', staffUserId: adminId, actor: { type: 'staff', id: adminId } }));
const rolesOf = async (userId: string) => (await admin.query('select role::text from public.staff_roles where user_id = $1 order by role', [userId])).rows.map((r) => r.role);

describe('staff roles', () => {
  it('grants and revokes roles with an audit record and alert', async () => {
    const member = await createUser();
    await change(member, 'operations', 'grant');
    await expect(change(member, 'operations', 'grant')).rejects.toMatchObject({ code: 'already_granted' });
    expect(await rolesOf(member)).toEqual(['operations']);
    await change(member, 'operations', 'revoke');
    expect(await rolesOf(member)).toEqual([]);
    expect((await admin.query("select count(*)::int as n from public.audit_events where action in ('staff.role_granted', 'staff.role_revoked')")).rows[0].n).toBe(2);
    expect((await admin.query("select count(*)::int as n from public.risk_events where kind like 'staff_role_%' and severity = 'high'")).rows[0].n).toBe(2);
  });

  it('never removes the last administrator, and only gives roles to active members', async () => {
    await expect(change(adminId, 'admin', 'revoke')).rejects.toMatchObject({ code: 'last_admin' });
    const second = await createUser();
    await change(second, 'admin', 'grant');
    await change(adminId, 'admin', 'revoke'); // fine now: another admin remains
    expect(await rolesOf(adminId)).toEqual([]);
    const pending = await createUser({ status: 'pending_approval' });
    await expect(change(pending, 'operations', 'grant')).rejects.toMatchObject({ code: 'member_not_active' });
  });
});
