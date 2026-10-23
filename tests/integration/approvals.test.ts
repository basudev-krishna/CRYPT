/**
 * Admin-approved sign-up. Sign-ups that arrive through Supabase Auth (session
 * user supabase_auth_admin) are simulated with SET SESSION AUTHORIZATION, so
 * the real auth.users triggers run.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { admin, closePools, createUser, resetAppData, simNetwork, web, worker } from '../helpers/db';
import { one, withTransaction } from '../../src/server/db-core';
import { decideSignup } from '../../src/server/approvals';
import { SimulatedCustodyProvider } from '../../src/server/custody/simulated';
import { getDepositInstructions } from '../../src/server/deposits/service';
import { checkRegistration, resolveLoginEmail } from '../../src/server/signup';
import type { Actor } from '../../src/server/ops';

beforeEach(resetAppData);
afterAll(closePools);

/**
 * Imitating a Supabase Auth sign-up needs SET SESSION AUTHORIZATION, which only
 * a superuser may run. Local Supabase allows it; hosted projects never do, so
 * those tests are skipped there (they still run locally and in CI).
 */
const canImpersonateAuth: boolean = (await admin.query('select rolsuper from pg_roles where rolname = current_user')).rows[0]?.rolsuper === true;
const itAuth = it.skipIf(!canImpersonateAuth);

const email = () => `${randomUUID().slice(0, 8)}@test.local`;

/** Insert an auth user the way Supabase Auth does on sign-up. */
async function authSignUp(addr: string, meta: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  const client = await admin.connect();
  try {
    await client.query('begin');
    await client.query('set local session authorization supabase_auth_admin');
    await client.query(
      `insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
       values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', now(), now(), now(), '{}', $3::jsonb)`,
      [id, addr, JSON.stringify(meta)],
    );
    await client.query('commit');
    return id;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

const status = async (id: string) => (await one<{ s: string }>(admin, 'select account_status::text as s from public.user_profiles where user_id = $1', [id])).s;
const decide = (actor: Actor, userId: string, decision: 'approve' | 'reject', note = 'Identity confirmed by phone') =>
  withTransaction(web, (db) => decideSignup(db, actor, { userId, decision, note }));

async function staffActor(): Promise<Actor> {
  const id = await createUser();
  await admin.query("insert into public.staff_roles (user_id, role) values ($1, 'admin')", [id]);
  return { type: 'staff', id };
}

describe('sign-up', () => {
  itAuth('needs no invitation, and puts Supabase Auth sign-ups in the approval queue', async () => {
    const id = await authSignUp(email());
    expect(await status(id)).toBe('pending_approval');
  });

  it('starts trusted superuser inserts (seed, tests) as active', async () => {
    expect(await status(await createUser())).toBe('active');
  });

  itAuth('blocks deposits for a pending account', async () => {
    const id = await authSignUp(email());
    const net = await simNetwork();
    await expect(getDepositInstructions(worker, new SimulatedCustodyProvider(worker), id, net.id, { type: 'user', id })).rejects.toMatchObject({ code: 'account_restricted' });
  });
});

describe('sign-up profile fields', () => {
  itAuth('copies name, username, phone, country and a valid referral into the profile', async () => {
    const sponsor = await createUser();
    const { member_code } = await one<{ member_code: string }>(admin, 'select member_code from public.user_profiles where user_id = $1', [sponsor]);
    const name = `u_${randomUUID().slice(0, 8)}`;
    const id = await authSignUp(email(), { full_name: 'Asha Rao', username: name.toUpperCase(), phone: '+919876543210', country_code: 'in', referral_code: member_code.toLowerCase() });
    const p = await one<Record<string, unknown>>(admin, 'select display_name, username, phone, country_code, sponsor_user_id from public.user_profiles where user_id = $1', [id]);
    expect(p).toEqual({ display_name: 'Asha Rao', username: name, phone: '+919876543210', country_code: 'IN', sponsor_user_id: sponsor });
  });

  itAuth('ignores an unknown referral id and refuses a duplicate username', async () => {
    const name = `u_${randomUUID().slice(0, 8)}`;
    const id = await authSignUp(email(), { username: name, referral_code: 'EW-999999' });
    expect((await one<{ s: string | null }>(admin, 'select sponsor_user_id as s from public.user_profiles where user_id = $1', [id])).s).toBeNull();
    await expect(authSignUp(email(), { username: name })).rejects.toThrow(/user_profiles_username_uq/);
    await expect(checkRegistration(web, { username: name, referralCode: null })).rejects.toMatchObject({ code: 'username_taken' });
    await expect(checkRegistration(web, { username: `${name}x`, referralCode: 'EW-999999' })).rejects.toMatchObject({ code: 'referral_not_found' });
  });

  itAuth('resolves a username to the account email, and nothing for unknown names', async () => {
    const addr = email();
    const name = `u_${randomUUID().slice(0, 8)}`;
    await authSignUp(addr, { username: name });
    expect(await resolveLoginEmail(web, ` ${name.toUpperCase()} `)).toBe(addr);
    expect(await resolveLoginEmail(web, 'nobody_here')).toBeNull();
    expect(await resolveLoginEmail(web, "x' or '1'='1")).toBeNull();
    expect(await resolveLoginEmail(web, 'Someone@Example.com')).toBe('someone@example.com');
  });
});

describe('decideSignup', () => {
  itAuth('approves a pending account, records who and when, and audits the note', async () => {
    const staff = await staffActor();
    const id = await authSignUp(email());
    await expect(decide(staff, id, 'approve')).resolves.toEqual({ status: 'active' });
    const p = await one<{ s: string; reviewed_by: string; reviewed_at: Date | null; reason: string | null }>(
      admin,
      'select account_status::text as s, reviewed_by, reviewed_at, restriction_reason as reason from public.user_profiles where user_id = $1',
      [id],
    );
    expect(p).toMatchObject({ s: 'active', reviewed_by: staff.id, reason: null });
    expect(p.reviewed_at).not.toBeNull();
    const audit = await one<{ n: number }>(admin, "select count(*)::int as n from public.audit_events where action = 'user.signup.approved' and subject_id = $1 and details->>'note' = 'Identity confirmed by phone'", [id]);
    expect(audit.n).toBe(1);
  });

  itAuth('rejects with the note as the reason, and allows a later approval', async () => {
    const staff = await staffActor();
    const id = await authSignUp(email());
    await decide(staff, id, 'reject', 'Unable to verify the applicant');
    expect(await status(id)).toBe('rejected');
    // Rejecting twice is refused; reconsidering is allowed.
    await expect(decide(staff, id, 'reject')).rejects.toMatchObject({ code: 'not_pending' });
    await decide(staff, id, 'approve');
    expect(await status(id)).toBe('active');
  });

  itAuth('refuses already-active accounts, self-review, non-staff and short notes', async () => {
    const staff = await staffActor();
    const active = await createUser();
    await expect(decide(staff, active, 'approve')).rejects.toMatchObject({ code: 'not_pending' });
    await expect(decide(staff, active, 'reject')).rejects.toMatchObject({ code: 'not_pending' });
    expect(await status(active)).toBe('active');

    const id = await authSignUp(email());
    await expect(decide(staff, staff.id, 'approve')).rejects.toMatchObject({ code: 'conflict_of_interest' });
    await expect(decide({ type: 'user', id: randomUUID() }, id, 'approve')).rejects.toMatchObject({ code: 'not_staff' });
    await expect(decide(staff, id, 'approve', 'ok')).rejects.toMatchObject({ code: 'note_required' });
    expect(await status(id)).toBe('pending_approval');
  });

  itAuth('lets exactly one of two concurrent decisions win', async () => {
    const [a, b] = await Promise.all([staffActor(), staffActor()]);
    const id = await authSignUp(email());
    const results = await Promise.allSettled([decide(a, id, 'approve'), decide(b, id, 'reject', 'Duplicate account found')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const audits = await one<{ n: number }>(admin, "select count(*)::int as n from public.audit_events where action like 'user.signup.%' and subject_id = $1", [id]);
    expect(audits.n).toBe(1);
  });
});
