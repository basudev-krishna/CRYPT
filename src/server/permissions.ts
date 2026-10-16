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
  'user.restrict': ['admin', 'compliance'],
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

/**
 * Four-eyes rule for resuming after an emergency pause: the admin resuming
 * must not be the person who paused (automatic system pauses excepted).
 */
export function canResume(roles: readonly StaffRole[], staffUserId: string, pausedBy: string): boolean {
  if (!can(roles, 'control.resume')) return false;
  return pausedBy !== `staff:${staffUserId}`;
}
