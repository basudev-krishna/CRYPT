import { describe, expect, it } from 'vitest';
import { buildTree } from '../../src/server/referrals/network';

const row = (user_id: string, parent_user_id: string | null, side: 'left' | 'right' | null, depth: number) => ({ user_id, parent_user_id, side, member_code: `EW-${user_id}`, depth });

describe('buildTree', () => {
  it('nests left and right children and counts whole teams per side', () => {
    const rows = [row('A', null, null, 0), row('B', 'A', 'left', 1), row('C', 'A', 'right', 1), row('D', 'B', 'left', 2)];
    const counts = new Map([['A', 3], ['B', 1], ['C', 0], ['D', 0]]);
    const t = buildTree(rows, 5, counts)!;
    expect(t.left[0]?.memberCode).toBe('EW-B');
    expect(t.right[0]?.memberCode).toBe('EW-C');
    expect(t.left[0]?.left[0]?.memberCode).toBe('EW-D');
    expect([t.leftCount, t.rightCount]).toEqual([2, 1]);
    expect(t.left[0]?.right).toEqual([]);
  });

  it('marks nodes whose team continues below the loaded depth', () => {
    const rows = [row('A', null, null, 0), row('B', 'A', 'left', 1)];
    const t = buildTree(rows, 1, new Map([['A', 5], ['B', 4]]))!;
    expect(t.left[0]?.truncated).toBe(true);
    expect(t.leftCount).toBe(5);
  });
});
