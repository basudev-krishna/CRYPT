/**
 * Administrator corrections to a member's details (name, sign-in username,
 * phone, country): audited, unique usernames, identity fields untouched.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { admin, closePools, createUser, resetAppData, web } from '../helpers/db';
import { one, withTransaction } from '../../src/server/db-core';
import { memberDetailsSchema, updateMemberDetails } from '../../src/server/admin-members';

let adminId: string;
beforeEach(async () => {
  await resetAppData();
  adminId = await createUser();
  await admin.query("insert into public.staff_roles (user_id, role) values ($1, 'admin')", [adminId]);
});
afterAll(closePools);

const edit = (userId: string, input: Record<string, string>) =>
  withTransaction(web, (db) => updateMemberDetails(db, { userId, details: memberDetailsSchema.parse(input), actor: { type: 'staff', id: adminId } }));
const details = { fullName: 'Asha Rao', username: 'Asha_R', phone: '+91 98765 43210', countryCode: 'IN' };

describe('member details', () => {
  it('updates name, username, phone and country with an audit record, leaving member id and sponsor alone', async () => {
    const m = await createUser();
    const before = await one<{ member_code: string; sponsor_user_id: string | null }>(admin, 'select member_code, sponsor_user_id from public.user_profiles where user_id = $1', [m]);
    await edit(m, details);
    const after = await one<Record<string, string | null>>(
      admin,
      'select display_name, username, phone, country_code, member_code, sponsor_user_id from public.user_profiles where user_id = $1',
      [m],
    );
    expect(after).toMatchObject({ display_name: 'Asha Rao', username: 'asha_r', phone: '+919876543210', country_code: 'IN', ...before });
    expect((await admin.query("select count(*)::int as n from public.audit_events where action = 'member.details_updated'")).rows[0].n).toBe(1);
  });

  it('changes only the name for an older member with no username or phone, and audits just that', async () => {
    const m = await createUser();
    await edit(m, { fullName: 'New Name', username: '', phone: '', countryCode: '' });
    const after = await one<Record<string, string | null>>(admin, 'select display_name, username, phone from public.user_profiles where user_id = $1', [m]);
    expect(after).toEqual({ display_name: 'New Name', username: null, phone: null });
    const audit = await one<{ details: { after: Record<string, unknown> } }>(admin, "select details from public.audit_events where action = 'member.details_updated'");
    expect(Object.keys(audit.details.after)).toEqual(['display_name']);
  });

  it('refuses a username another member already uses', async () => {
    const a = await createUser();
    const b = await createUser();
    await edit(a, details);
    await expect(edit(b, { ...details, phone: '+919876543211' })).rejects.toMatchObject({ code: 'username_taken' });
  });
});
