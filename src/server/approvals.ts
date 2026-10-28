/**
 * Admin approval of new sign-ups.
 *
 * Since 20261028000100_signup_approval_not_required.sql new sign-ups start
 * 'active', so nothing new enters the queue. This remains for accounts that
 * were rejected earlier: an administrator can still approve them here.
 */
import { many, type Db } from './db-core';
import { notify, recordAudit, type Actor } from './ops';

export class ApprovalError extends Error {
  override name = 'ApprovalError';
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export type SignupDecision = 'approve' | 'reject';

/**
 * Approve or reject one account. Runs inside the caller's transaction. The
 * status check is part of the UPDATE, so two staff deciding at once cannot
 * both win, and a retried request reports the account as already decided.
 * A rejected account can be approved later; an approved one is managed through
 * the account-status actions instead.
 */
export async function decideSignup(
  db: Db,
  actor: Actor,
  input: { userId: string; decision: SignupDecision; note: string },
): Promise<{ status: 'active' | 'rejected' }> {
  if (actor.type !== 'staff') throw new ApprovalError('Only staff can review sign-ups', 'not_staff');
  if (input.userId === actor.id) throw new ApprovalError('Staff cannot review their own account', 'conflict_of_interest');
  const note = input.note.trim();
  if (note.length < 10) throw new ApprovalError('A documented note of at least 10 characters is required', 'note_required');

  const status = input.decision === 'approve' ? 'active' : 'rejected';
  const from = input.decision === 'approve' ? ['pending_approval', 'rejected'] : ['pending_approval'];
  const rows = await many<{ email: string }>(
    db,
    `update public.user_profiles
        set account_status = $2::public.account_status, restriction_reason = $3, reviewed_at = now(), reviewed_by = $4
      where user_id = $1 and account_status::text = any($5::text[])
      returning email`,
    [input.userId, status, status === 'rejected' ? note : null, actor.id, from],
  );
  if (rows.length === 0) throw new ApprovalError('This account is not awaiting approval (it may already have been decided)', 'not_pending');

  await recordAudit(db, actor, `user.signup.${input.decision === 'approve' ? 'approved' : 'rejected'}`, { type: 'user', id: input.userId }, { note });
  await notify(db, { userId: input.userId, kind: 'account_status_changed', payload: { status }, dedupeKey: `signup-decision:${input.userId}:${status}` });
  return { status };
}
