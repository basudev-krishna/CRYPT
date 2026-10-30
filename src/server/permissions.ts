/**
 * Staff permission matrix (single source of truth, unit tested).
 * Every admin API route names the action it performs; the route checks the
 * caller's roles against this table on the server.
 */
export type StaffRole = 'admin' | 'operations' | 'compliance' | 'read_only';

export const PERMISSIONS = {
  'console.view': ['admin', 'operations', 'compliance', 'read_only'],
  'kyc.review': ['admin', 'compliance'],
  'deposit.review': ['admin', 'compliance'],
  'deposit.investigate': ['admin', 'operations', 'compliance'],
  'withdrawal.review': ['admin', 'compliance'],
  'withdrawal.hold': ['admin', 'compliance'],
  'withdrawal.payout': ['admin'], // records a manually signed payout, or declines it
  'deposit.allocate': ['admin'], // assign, distribute or correct group-wallet receipts
  'user.restrict': ['admin', 'compliance'],
  'user.approve': ['admin'], // new sign-ups wait for an administrator
  'member.edit': ['admin'], // correct a member's name, username, phone and country (audited)
  'member.invite': ['admin'], // membership is admin-controlled; also covers revoking
  'referral.review': ['admin'], // approve or reject a referral reward (operator money)
  'referral.configure': ['admin'], // referral reward amount, program start and tiers
  'staff.manage': ['admin'], // grant or revoke staff roles (never the last admin)
  'network.manage': ['admin'], // correct sponsors, place and move members left/right
  'balance.adjust': ['admin'], // credit/debit a member against the operator float (always alerted)
  'offchain.record': ['admin'], // off-platform holdings: money members handed the admin personally
  'returns.configure': ['admin'], // create, activate (four-eyes) and close fixed daily-return plans
  'risk.resolve': ['admin', 'compliance'],
  'control.pause': ['admin', 'operations', 'compliance'], // anyone on duty can stop payouts
  'control.resume': ['admin'], // resuming is exceptional; see canResume()
  'jobs.trigger': ['admin', 'operations'],
  'report.export': ['admin', 'operations', 'compliance'],
} as const satisfies Record<string, readonly StaffRole[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(roles: readonly StaffRole[], permission: Permission): boolean {
  const allowed: readonly StaffRole[] = PERMISSIONS[permission];
  return roles.some((r) => allowed.includes(r));
}

/** How long a sole administrator must wait before resuming a pause they enabled themselves. */
export const SOLE_ADMIN_RESUME_COOLDOWN_MS = 60 * 60_000;

/**
 * Four-eyes rule for resuming after an emergency pause: the admin resuming
 * must not be the person who paused (automatic system pauses excepted). A sole
 * administrator has nobody else, so they may resume their own pause after a
 * cooling-off period; the route alerts on it.
 */
export function canResume(
  roles: readonly StaffRole[],
  staffUserId: string,
  pausedBy: string,
  opts: { soleAdmin?: boolean; pausedAt?: Date; now?: Date } = {},
): boolean {
  if (!can(roles, 'control.resume')) return false;
  if (pausedBy !== `staff:${staffUserId}`) return true;
  if (!opts.soleAdmin || !opts.pausedAt) return false;
  return (opts.now ?? new Date()).getTime() - opts.pausedAt.getTime() >= SOLE_ADMIN_RESUME_COOLDOWN_MS;
}
