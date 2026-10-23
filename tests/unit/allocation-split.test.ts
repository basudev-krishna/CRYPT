import { describe, expect, it } from 'vitest';
import { validateSplit } from '../../src/server/deposits/allocations';

const line = (userId: string, amount: bigint) => ({ userId, amount });

describe('allocation split', () => {
  it('accepts an assignment of the whole receipt to one member', () => {
    expect(validateSplit('assignment', 500n, [line('a', 500n)])).toBeNull();
  });

  it('accepts a distribution that adds up exactly', () => {
    expect(validateSplit('distribution', 1_000n, [line('a', 333n), line('b', 333n), line('c', 334n)])).toBeNull();
  });

  it('never lets the lines credit more or less than was received', () => {
    expect(validateSplit('distribution', 1_000n, [line('a', 500n), line('b', 501n)])).toMatch(/add up exactly/);
    expect(validateSplit('distribution', 1_000n, [line('a', 500n), line('b', 499n)])).toMatch(/add up exactly/);
  });

  it('rejects empty, duplicate, non-positive and multi-member assignments', () => {
    expect(validateSplit('distribution', 1n, [])).toMatch(/at least one/);
    expect(validateSplit('distribution', 2n, [line('a', 1n), line('a', 1n)])).toMatch(/only once/);
    expect(validateSplit('distribution', 0n, [line('a', 0n)])).toMatch(/positive/);
    expect(validateSplit('assignment', 2n, [line('a', 1n), line('b', 1n)])).toMatch(/exactly one/);
  });
});
