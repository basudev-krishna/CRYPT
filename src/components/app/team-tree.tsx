import Link from 'next/link';
import type { TreeNode } from '@/server/referrals/network';

/**
 * Left/right team tree with native expand/collapse (<details>), so it works
 * without client JavaScript. `hrefFor` makes nodes links (admin only).
 */
export function TeamTree({ node, hrefFor, depth = 0 }: { node: TreeNode; hrefFor?: (n: TreeNode) => string; depth?: number }) {
  const label = hrefFor ? (
    <Link className="font-mono text-accent hover:underline" href={hrefFor(node)}>
      {node.memberCode}
    </Link>
  ) : (
    <span className="font-mono">{node.memberCode}</span>
  );
  const hasKids = node.left.length > 0 || node.right.length > 0;
  return (
    <details open={depth < 2} className="group">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-surface-3">
        <span aria-hidden className={`inline-block w-3 text-fg-muted transition-transform ${hasKids ? 'group-open:rotate-90' : ''}`}>{hasKids ? '▸' : '•'}</span>
        {node.side ? <span className="rounded-full border border-line px-1.5 text-[10px] uppercase tracking-wide text-fg-muted">{node.side}</span> : null}
        {label}
        <span className="text-xs text-fg-muted">
          L {node.leftCount} · R {node.rightCount}
        </span>
        {node.truncated ? <span className="text-xs text-fg-subtle">(more below)</span> : null}
      </summary>
      {hasKids ? (
        <div className="ml-3 border-l border-line pl-3">
          {(['left', 'right'] as const).map((side) =>
            node[side].length ? (
              node[side].map((child) => <TeamTree key={child.userId} node={child} hrefFor={hrefFor} depth={depth + 1} />)
            ) : (
              <p key={side} className="px-2 py-1 text-xs text-fg-subtle">
                {side}: empty
              </p>
            ),
          )}
        </div>
      ) : null}
    </details>
  );
}
