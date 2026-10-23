import { describe, expect, it } from 'vitest';
import { can, canResume, PERMISSIONS } from '../../src/server/permissions';

describe('staff permissions', () => {
  it('gives read-only staff no write permissions', () => {
    const writes = Object.keys(PERMISSIONS).filter((p) => p !== 'console.view') as (keyof typeof PERMISSIONS)[];
    for (const p of writes) expect(can(['read_only'], p)).toBe(false);
    expect(can(['read_only'], 'console.view')).toBe(true);
  });

  it('separates compliance decisions from operations', () => {
    expect(can(['operations'], 'withdrawal.review')).toBe(false);
    expect(can(['operations'], 'kyc.review')).toBe(false);
    expect(can(['compliance'], 'withdrawal.review')).toBe(true);
    expect(can(['compliance'], 'jobs.trigger')).toBe(false);
  });

  it('lets any on-duty staff pause but only an admin resume, and not the one who paused', () => {
    expect(can(['operations'], 'control.pause')).toBe(true);
    expect(can(['operations'], 'control.resume')).toBe(false);
    expect(canResume(['admin'], 'u1', 'staff:u1')).toBe(false);
    expect(canResume(['admin'], 'u1', 'staff:u2')).toBe(true);
    expect(canResume(['admin'], 'u1', 'service:reconciliation')).toBe(true);
    expect(canResume(['compliance'], 'u1', 'staff:u2')).toBe(false);
  });

  it('lets a sole administrator resume their own pause only after the cooling-off period', () => {
    const pausedAt = new Date('2026-10-24T10:00:00Z');
    const at = (min: number) => new Date(pausedAt.getTime() + min * 60_000);
    expect(canResume(['admin'], 'u1', 'staff:u1', { soleAdmin: true, pausedAt, now: at(59) })).toBe(false);
    expect(canResume(['admin'], 'u1', 'staff:u1', { soleAdmin: true, pausedAt, now: at(60) })).toBe(true);
    // Not the sole admin: four-eyes still applies however long ago it was.
    expect(canResume(['admin'], 'u1', 'staff:u1', { soleAdmin: false, pausedAt, now: at(600) })).toBe(false);
    expect(canResume(['compliance'], 'u1', 'staff:u1', { soleAdmin: true, pausedAt, now: at(600) })).toBe(false);
  });

  it('reserves payouts and allocations to admins', () => {
    for (const p of ['withdrawal.payout', 'deposit.allocate'] as const) {
      expect(can(['admin'], p)).toBe(true);
      expect(can(['operations'], p)).toBe(false);
      expect(can(['compliance'], p)).toBe(false);
    }
  });

  it('lets only admins invite members', () => {
    expect(can(['admin'], 'member.invite')).toBe(true);
    expect(can(['compliance'], 'member.invite')).toBe(false);
    expect(can(['operations'], 'member.invite')).toBe(false);
  });

  it('lets only admins approve sign-ups', () => {
    expect(can(['admin'], 'user.approve')).toBe(true);
    expect(can(['compliance'], 'user.approve')).toBe(false);
    expect(can(['operations'], 'user.approve')).toBe(false);
  });

  it('never grants permissions to users without a staff role', () => {
    for (const p of Object.keys(PERMISSIONS) as (keyof typeof PERMISSIONS)[]) expect(can([], p)).toBe(false);
  });
});
