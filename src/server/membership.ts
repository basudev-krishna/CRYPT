/**
 * Private membership: staff-issued invitations, member ids and sponsors.
 *
 * Sign-up is gated in the database (`private.consume_invitation`), not here:
 * this module only issues and revokes invitations. Only a hash of each code is
 * stored; the plain code is returned once to the issuing staff member.
 */
import { randomBytes } from 'node:crypto';
import { maybeOne, one, pgErrorCode, type Db } from './db-core';
import { actorRef, recordAudit, type Actor } from './ops';

export class MembershipError extends Error {
  override name = 'MembershipError';
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

// 32 symbols without look-alikes (0/O, 1/I). 256 is a multiple of 32, so masking a byte is unbiased.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 20; // 100 bits

/** A fresh invitation code, grouped for reading aloud: XXXX-XXXX-XXXX-XXXX-XXXX. */
export function generateInvitationCode(): string {
  const chars = [...randomBytes(CODE_LENGTH)].map((b) => ALPHABET[b & 31]).join('');
  return chars.match(/.{4}/g)!.join('-');
}

export const MIN_INVITE_DAYS = 1;
export const MAX_INVITE_DAYS = 30;

export interface IssuedInvitation {
  id: string;
  email: string;
  code: string;
  expiresAt: Date;
  sponsorMemberCode: string | null;
}

export async function issueInvitation(
  db: Db,
  actor: Actor,
  input: { email: string; sponsorMemberCode: string | null; note: string; validDays: number },
): Promise<IssuedInvitation> {
  const email = input.email.trim().toLowerCase();
  if (!Number.isInteger(input.validDays) || input.validDays < MIN_INVITE_DAYS || input.validDays > MAX_INVITE_DAYS) {
    throw new MembershipError(`Invitations last between ${MIN_INVITE_DAYS} and ${MAX_INVITE_DAYS} days`, 'invalid_expiry');
  }
  if (await maybeOne(db, 'select 1 from public.user_profiles where lower(email) = $1', [email])) {
    throw new MembershipError('That email address already has an account', 'already_member');
  }
  let sponsor: { user_id: string; member_code: string } | null = null;
  if (input.sponsorMemberCode) {
    sponsor = await maybeOne(db, "select user_id, member_code from public.user_profiles where member_code = $1 and account_status = 'active'", [
      input.sponsorMemberCode.trim().toUpperCase(),
    ]);
    if (!sponsor) throw new MembershipError('No active member has that member id', 'sponsor_not_found');
  }
  const code = generateInvitationCode();
  let row: { id: string; expires_at: Date };
  try {
    row = await one(
      db,
      `insert into public.member_invitations (email, code_hash, sponsor_user_id, note, created_by, expires_at)
       values ($1, private.invitation_code_hash($2), $3, $4, $5, now() + make_interval(days => $6))
       returning id, expires_at`,
      [email, code, sponsor?.user_id ?? null, input.note.trim(), actorRef(actor), input.validDays],
    );
  } catch (err) {
    if (pgErrorCode(err) === '23505') throw new MembershipError('An invitation for that email is already open. Revoke it first.', 'invitation_pending');
    throw err;
  }
  await recordAudit(db, actor, 'member.invitation_issued', { type: 'member_invitation', id: row.id }, {
    email,
    sponsorMemberCode: sponsor?.member_code ?? null,
    expiresAt: row.expires_at,
    note: input.note.trim(),
  });
  return { id: row.id, email, code, expiresAt: row.expires_at, sponsorMemberCode: sponsor?.member_code ?? null };
}

export async function revokeInvitation(db: Db, actor: Actor, id: string, reason: string): Promise<void> {
  const res = await db.query(
    `update public.member_invitations set status = 'revoked', revoked_by = $2, revoked_at = now(), revoke_reason = $3
      where id = $1 and status = 'pending'`,
    [id, actorRef(actor), reason.trim()],
  );
  if (res.rowCount !== 1) throw new MembershipError('Only a pending invitation can be revoked', 'not_pending');
  await recordAudit(db, actor, 'member.invitation_revoked', { type: 'member_invitation', id }, { reason: reason.trim() });
}
