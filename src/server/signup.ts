/**
 * Username sign-in and open registration (new accounts start active; no admin
 * approval is needed).
 *
 * A username is only an alias for the email address Supabase Auth signs in
 * with. The lookup happens on the server and the email is never returned, so
 * the sign-in form cannot be used to discover members' addresses.
 */
import { z } from 'zod';
import { maybeOne, type Db } from './db-core';
import { placementAvailability } from './referrals/program';

export class SignupError extends Error {
  override name = 'SignupError';
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export const USERNAME_RE = /^[a-z0-9_]{4,20}$/;
export const PHONE_RE = /^\+[1-9][0-9]{6,14}$/;

export const registerSchema = z.object({
  fullName: z.string().trim().min(2, 'Enter your full name').max(60, 'At most 60 characters'),
  username: z.string().trim().toLowerCase().regex(USERNAME_RE, '4–20 characters: letters, digits or underscore'),
  email: z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address')),
  phone: z
    .string()
    .transform((s) => s.replace(/[\s().-]/g, ''))
    .pipe(z.string().regex(PHONE_RE, 'Include the country code, e.g. +91 98765 43210')),
  countryCode: z.string().regex(/^[A-Z]{2}$/, 'Choose your country'),
  password: z
    .string()
    .min(12, 'At least 12 characters')
    .max(72, 'At most 72 characters')
    .regex(/[a-z]/, 'Add a lower-case letter')
    .regex(/[A-Z]/, 'Add an upper-case letter')
    .regex(/[0-9]/, 'Add a digit'),
  referralCode: z
    .string()
    .trim()
    .toUpperCase()
    .transform((s) => s || null)
    .pipe(z.string().regex(/^EW-[0-9]{6,}$/, 'Referral ids look like EW-000123').nullable())
    .optional()
    .transform((v) => v ?? null),
  /** Team position under the sponsor; required with a referral id, ignored without one. */
  teamSide: z.enum(['left', 'right']).nullable().optional().transform((v) => v ?? null),
});

export type RegisterInput = z.infer<typeof registerSchema>;

/** The email to sign in with, or null if no account matches (callers show one generic error either way). */
export async function resolveLoginEmail(db: Db, identifier: string): Promise<string | null> {
  const id = identifier.trim().toLowerCase();
  if (id.includes('@')) return id;
  if (!USERNAME_RE.test(id)) return null;
  const row = await maybeOne<{ email: string }>(db, 'select email from public.user_profiles where username = $1', [id]);
  return row?.email ?? null;
}

/**
 * Checks that give the applicant a clear message before Supabase Auth is
 * called. The database still enforces username uniqueness, so a race between
 * two sign-ups fails safely in the auth trigger.
 */
export async function checkRegistration(db: Db, input: Pick<RegisterInput, 'username' | 'referralCode'> & { teamSide?: RegisterInput['teamSide'] }): Promise<void> {
  if (await maybeOne(db, 'select 1 from public.user_profiles where username = $1', [input.username])) {
    throw new SignupError('That username is taken. Choose another.', 'username_taken');
  }
  if (input.referralCode && !(await maybeOne(db, "select 1 from public.user_profiles where member_code = $1 and account_status = 'active'", [input.referralCode]))) {
    throw new SignupError('That referral id was not found.', 'referral_not_found');
  }
  if (input.referralCode && input.teamSide !== undefined) await checkTeamSide(db, input.referralCode, input.teamSide);
}

/**
 * The chosen side must be given, and free when the program places directly
 * under the sponsor. Never switched silently: the applicant chooses again.
 * The auth trigger re-checks under lock, so a race still fails safely.
 */
async function checkTeamSide(db: Db, referralCode: string, side: RegisterInput['teamSide']): Promise<void> {
  if (!side) throw new SignupError('Choose the left or right team.', 'team_side_required');
  const a = await placementAvailability(db, referralCode);
  if (a && a.mode === 'direct' && !a.direct[side]) {
    const other = side === 'left' ? 'right' : 'left';
    throw new SignupError(
      a.direct[other] ? `The ${side} team position under ${a.sponsorCode} is taken. Choose the ${other} team.` : `Both team positions under ${a.sponsorCode} are taken.`,
      'position_taken',
    );
  }
}
