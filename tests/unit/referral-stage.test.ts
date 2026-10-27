import { describe, expect, it } from 'vitest';
import { referralStage } from '../../src/server/queries/user';

describe('referralStage', () => {
  const at = new Date('2026-10-01T00:00:00Z');
  it('qualifies only approved accounts with a credited deposit', () => {
    expect(referralStage('active', at)).toBe('qualified');
    expect(referralStage('active', null)).toBe('joined');
    expect(referralStage('pending_approval', null)).toBe('awaiting_approval');
  });
  it('never qualifies rejected or blocked accounts, even if they were funded', () => {
    for (const s of ['rejected', 'restricted', 'frozen', 'closed']) expect(referralStage(s, at)).toBe('inactive');
  });
});
