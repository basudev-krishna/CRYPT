/**
 * Invitation service and membership data limits. The sign-up gate itself is
 * switched off (see approvals.test.ts); the invitation records are kept.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { admin, closePools, createUser, resetAppData, web } from '../helpers/db';
import { one } from '../../src/server/db-core';
import { issueInvitation, MembershipError, revokeInvitation } from '../../src/server/membership';
import type { Actor } from '../../src/server/ops';

const staff: Actor = { type: 'staff', id: randomUUID() };

beforeEach(resetAppData);
afterAll(async () => {
  await admin.query("delete from public.member_invitations where email like '%@test.local'").catch(() => undefined);
  await closePools();
});

const email = () => `${randomUUID().slice(0, 8)}@test.local`;

describe('invitation service', () => {
  it('stores only a hash of the code and audits the issue', async () => {
    const inv = await issueInvitation(web, staff, { email: email(), sponsorMemberCode: null, note: 'Audit trail check', validDays: 14 });
    const row = await one<{ code_hash: string }>(admin, 'select code_hash from public.member_invitations where id = $1', [inv.id]);
    expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.code_hash).not.toContain(inv.code.replace(/-/g, ''));
    const audit = await one<{ n: number }>(admin, "select count(*)::int as n from public.audit_events where action = 'member.invitation_issued' and subject_id = $1", [inv.id]);
    expect(audit.n).toBe(1);
  });

  it('refuses unknown sponsors, existing members, a second open invitation, and bad expiry', async () => {
    const existing = await createUser();
    const existingEmail = (await one<{ email: string }>(admin, 'select email from public.user_profiles where user_id = $1', [existing])).email;
    const base = { sponsorMemberCode: null, note: 'Validation checks', validDays: 7 };
    await expect(issueInvitation(web, staff, { ...base, email: email(), sponsorMemberCode: 'EW-999999' })).rejects.toMatchObject({ code: 'sponsor_not_found' });
    await expect(issueInvitation(web, staff, { ...base, email: existingEmail })).rejects.toMatchObject({ code: 'already_member' });
    await expect(issueInvitation(web, staff, { ...base, email: email(), validDays: 31 })).rejects.toBeInstanceOf(MembershipError);
    const addr = email();
    await issueInvitation(web, staff, { ...base, email: addr });
    await expect(issueInvitation(web, staff, { ...base, email: addr })).rejects.toMatchObject({ code: 'invitation_pending' });
  });

  it('revokes only pending invitations', async () => {
    const inv = await issueInvitation(web, staff, { email: email(), sponsorMemberCode: null, note: 'Revocation check', validDays: 7 });
    await revokeInvitation(web, staff, inv.id, 'No longer joining the group');
    await expect(revokeInvitation(web, staff, inv.id, 'No longer joining the group')).rejects.toMatchObject({ code: 'not_pending' });
  });
});

describe('web role limits on membership data', () => {
  it('cannot accept, delete or rewrite invitations', async () => {
    const inv = await issueInvitation(web, staff, { email: email(), sponsorMemberCode: null, note: 'Privilege check', validDays: 7 });
    const u = await createUser();
    await expect(web.query("update public.member_invitations set status = 'accepted', accepted_user_id = $2, accepted_at = now() where id = $1", [inv.id, u])).rejects.toThrow(/permission denied/);
    await expect(web.query("update public.member_invitations set email = 'x@test.local' where id = $1", [inv.id])).rejects.toThrow(/permission denied/);
    await expect(web.query("update public.member_invitations set expires_at = now() + interval '1 year' where id = $1", [inv.id])).rejects.toThrow(/permission denied/);
    await expect(web.query('delete from public.member_invitations where id = $1', [inv.id])).rejects.toThrow(/permission denied/);
  });

  it('cannot create profiles or change member ids and sponsors', async () => {
    const a = await createUser();
    const b = await createUser();
    await expect(web.query('update public.user_profiles set sponsor_user_id = $2 where user_id = $1', [a, b])).rejects.toThrow(/permission denied/);
    await expect(web.query("update public.user_profiles set member_code = 'EW-000001' where user_id = $1", [a])).rejects.toThrow(/permission denied/);
    await expect(web.query("insert into public.user_profiles (user_id, email) values (gen_random_uuid(), 'x@test.local')")).rejects.toThrow(/permission denied/);
    // Even the table owner cannot rewrite a member's identity.
    await expect(admin.query('update public.user_profiles set sponsor_user_id = $2 where user_id = $1', [a, b])).rejects.toThrow(/permanent/);
  });

  it('is invisible to the public API roles', async () => {
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query('set local role authenticated');
      await expect(client.query('select * from public.member_invitations')).rejects.toThrow(/permission denied/);
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  });
});
