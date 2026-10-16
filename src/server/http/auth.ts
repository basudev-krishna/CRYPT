import 'server-only';
import { cache } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { supabaseServer } from './supabase';
import { webDb } from '../db';
import { many } from '../db-core';
import type { Actor } from '../ops';
import { can, type Permission, type StaffRole } from '../permissions';

export type { StaffRole };

export interface SessionUser {
  id: string;
  email: string;
  emailVerified: boolean;
  aal: 'aal1' | 'aal2';
  hasMfaFactor: boolean;
  roles: StaffRole[];
}

export class AuthError extends Error {
  override name = 'AuthError';
  constructor(
    message: string,
    readonly status: 401 | 403,
    readonly code: string,
  ) {
    super(message);
  }
}

/**
 * Resolve the signed-in user. getUser() validates the JWT with the auth
 * server (so revoked sessions are rejected); roles come from our database,
 * never from client-editable metadata.
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  const roles = await many<{ role: StaffRole }>(webDb(), 'select role from public.staff_roles where user_id = $1', [data.user.id]);
  return {
    id: data.user.id,
    email: data.user.email ?? '',
    emailVerified: Boolean(data.user.email_confirmed_at),
    aal: aal?.currentLevel === 'aal2' ? 'aal2' : 'aal1',
    hasMfaFactor: (data.user.factors ?? []).some((f) => f.status === 'verified'),
    roles: roles.map((r) => r.role),
  };
});

export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new AuthError('Sign in required', 401, 'unauthenticated');
  if (!user.emailVerified) throw new AuthError('Verify your email address first', 403, 'email_unverified');
  // A user who has enrolled MFA must complete it for every session.
  if (user.hasMfaFactor && user.aal !== 'aal2') throw new AuthError('Two-factor verification required', 401, 'mfa_required');
  return user;
}

/** Staff access: role membership AND an MFA-verified (AAL2) session, checked server-side. */
export async function requireStaff(allowed: StaffRole[]): Promise<SessionUser> {
  const user = await requireUser();
  if (!user.roles.some((r) => allowed.includes(r))) throw new AuthError('Not permitted', 403, 'forbidden');
  if (user.aal !== 'aal2') throw new AuthError('Staff access requires two-factor authentication', 403, 'staff_mfa_required');
  return user;
}

/** Staff access for a specific action from the permission matrix. */
export async function requirePermission(permission: Permission): Promise<SessionUser> {
  const user = await requireStaff(['admin', 'operations', 'compliance', 'read_only']);
  if (!can(user.roles, permission)) throw new AuthError('Not permitted', 403, 'forbidden');
  return user;
}

export const STAFF_ANY: StaffRole[] = ['admin', 'operations', 'compliance', 'read_only'];

/** Page-level guards: redirect instead of throwing. */
export async function pageUser(): Promise<SessionUser> {
  try {
    return await requireUser();
  } catch (err) {
    if (err instanceof AuthError) {
      if (err.code === 'mfa_required') redirect('/login/mfa');
      if (err.code === 'email_unverified') redirect('/login?notice=verify');
      redirect('/login');
    }
    throw err;
  }
}

export async function pageStaff(allowed: StaffRole[] = STAFF_ANY): Promise<SessionUser> {
  const user = await pageUser();
  if (!user.roles.some((r) => allowed.includes(r))) redirect('/dashboard');
  if (user.aal !== 'aal2') redirect('/settings/security?notice=staff-mfa');
  return user;
}

export async function requestActor(user: SessionUser, kind: 'user' | 'staff' = 'user'): Promise<Actor> {
  const h = await headers();
  const chain = (h.get('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const hops = Number(process.env.TRUSTED_PROXY_HOPS ?? 1);
  const ip = chain[chain.length - (Number.isInteger(hops) && hops > 0 ? hops : 1)] ?? null; // see clientIp()
  return { type: kind, id: user.id, ip: ip && /^[0-9a-fA-F:.]+$/.test(ip) ? ip : null, userAgent: h.get('user-agent')?.slice(0, 300) ?? null };
}
