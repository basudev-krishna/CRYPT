/**
 * Administrator-created accounts: the admin signs a member up directly instead
 * of the member using the public form.
 *
 * The account is created through the same Supabase Auth sign-up as the public
 * form (anon key, so the app still never holds the service role), on a
 * client with no cookies so the administrator's own session is untouched. The
 * auth trigger creates the profile and the permanent sponsor link; the
 * administrator's chosen position is then set with setPlacement, which may put
 * the member on a taken spot (the member there moves down). The member gets
 * the usual verification email and signs in with the password the
 * administrator gave them.
 */
import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { maybeOne, one, pgErrorCode, type Db } from './db-core';
import { serverEnv } from './env';
import { recordAudit, type Actor } from './ops';
import { setPlacement } from './referrals/network';
import { checkRegistration, registerSchema } from './signup';

export class AdminMemberError extends Error {
  override name = 'AdminMemberError';
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export const adminMemberSchema = registerSchema.extend({
  /** Where to put them: under this member (defaults to the sponsor), on `teamSide`. */
  parentCode: z
    .string()
    .trim()
    .toUpperCase()
    .transform((s) => s || null)
    .pipe(z.string().regex(/^EW-[0-9]{6,}$/, 'Member ids look like EW-000123').nullable())
    .optional()
    .transform((v) => v ?? null),
});
export type AdminMemberInput = z.infer<typeof adminMemberSchema>;

/** Step 1, before Auth: the same checks as the public form, minus the side (the admin may take any spot). */
export async function checkAdminMember(db: Db, input: AdminMemberInput): Promise<void> {
  await checkRegistration(db, { username: input.username, referralCode: input.referralCode });
  if (input.parentCode && !(await maybeOne(db, 'select 1 from public.user_profiles where member_code = $1', [input.parentCode]))) {
    throw new AdminMemberError(`No member has the id ${input.parentCode}`, 'parent_not_found');
  }
}

/** Step 2: create the Auth account. Returns the new user id. */
export async function createAuthAccount(input: AdminMemberInput, origin: string): Promise<string> {
  const env = serverEnv();
  const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await supabase.auth.signUp({
    email: input.email,
    password: input.password,
    options: {
      emailRedirectTo: `${origin}/auth/callback?next=/dashboard`,
      // No team_side: the administrator's placement below is recorded as theirs, not the member's.
      data: { full_name: input.fullName, username: input.username, phone: input.phone, country_code: input.countryCode, referral_code: input.referralCode },
    },
  });
  if (error) {
    if (error.code === 'user_already_exists' || error.code === 'email_exists') throw new AdminMemberError('An account with this email already exists.', 'email_taken');
    if (error.code === 'weak_password') throw new AdminMemberError(error.message, 'weak_password');
    if (/database error/i.test(error.message)) throw new AdminMemberError('That username was just taken. Choose another.', 'username_taken');
    if (/sending.*email/i.test(error.message)) throw new AdminMemberError('The verification email could not be sent. Check the email settings and try again.', 'email_send_failed');
    throw new AdminMemberError('The account could not be created. Try again in a few minutes.', 'signup_failed');
  }
  // For an address that already exists, Auth answers with a stand-in user that has no identities.
  if (!data.user || data.user.identities?.length === 0) throw new AdminMemberError('An account with this email already exists.', 'email_taken');
  return data.user.id;
}

/** Step 3, in one transaction: place the new member and record who added them. */
export async function placeAdminMember(db: Db, args: { userId: string; input: AdminMemberInput; staffUserId: string; actor: Actor }): Promise<{ memberCode: string }> {
  const { input } = args;
  await setPlacement(db, {
    userId: args.userId,
    parentMemberCode: input.parentCode ?? input.referralCode,
    side: input.teamSide,
    reason: 'Added by the administrator',
    staffUserId: args.staffUserId,
    actor: args.actor,
  });
  const p = await maybeOne<{ member_code: string }>(db, 'select member_code from public.user_profiles where user_id = $1', [args.userId]);
  await recordAudit(db, args.actor, 'member.created_by_admin', { type: 'user', id: args.userId }, {
    email: input.email,
    username: input.username,
    sponsor: input.referralCode,
    parent: input.parentCode ?? input.referralCode,
    side: input.teamSide,
  });
  return { memberCode: p?.member_code ?? '' };
}

const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
/** Username, phone and country may be blank: members who joined before those fields existed have none. */
export const memberDetailsSchema = registerSchema.pick({ fullName: true }).extend({
  username: z.preprocess(blankToNull, registerSchema.shape.username.nullable()),
  phone: z.preprocess(blankToNull, registerSchema.shape.phone.nullable()),
  countryCode: z.preprocess(blankToNull, registerSchema.shape.countryCode.nullable()),
});
export type MemberDetails = z.infer<typeof memberDetailsSchema>;

/**
 * Correct a member's details, e.g. a typo in a login the administrator created.
 * The username is the sign-in alias, so a change takes effect at their next
 * sign-in. Email, member id and sponsor are not editable here.
 */
export async function updateMemberDetails(db: Db, args: { userId: string; details: MemberDetails; actor: Actor }): Promise<void> {
  const d = args.details;
  const before = await maybeOne<{ display_name: string | null; username: string | null; phone: string | null; country_code: string | null }>(
    db,
    'select display_name, username, phone, country_code from public.user_profiles where user_id = $1 for update',
    [args.userId],
  );
  if (!before) throw new AdminMemberError('No member has that id', 'member_not_found');
  // Write only what changed: username and phone need their own column grant.
  const after = { display_name: d.fullName, username: d.username, phone: d.phone, country_code: d.countryCode };
  const changed = (Object.keys(after) as (keyof typeof after)[]).filter((k) => after[k] !== before[k]);
  if (!changed.length) return;
  if (before.username && !d.username) throw new AdminMemberError('A username cannot be removed, only changed.', 'username_required');
  if (changed.includes('username') && (await maybeOne(db, 'select 1 from public.user_profiles where username = $1', [d.username]))) {
    throw new AdminMemberError('That username is taken. Choose another.', 'username_taken');
  }
  try {
    await one(
      db,
      `update public.user_profiles set ${changed.map((k, i) => `${k} = $${i + 2}`).join(', ')} where user_id = $1 returning user_id`,
      [args.userId, ...changed.map((k) => after[k])],
    );
  } catch (err) {
    if (pgErrorCode(err) === '23505') throw new AdminMemberError('That username is taken. Choose another.', 'username_taken');
    if (pgErrorCode(err) === '42501') throw new AdminMemberError('Username and phone can be changed once the latest database migration is applied.', 'migration_pending');
    throw err;
  }
  await recordAudit(db, args.actor, 'member.details_updated', { type: 'user', id: args.userId }, {
    before,
    after: Object.fromEntries(changed.map((k) => [k, after[k]])),
  });
}
