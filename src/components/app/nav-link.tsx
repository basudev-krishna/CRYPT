'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import type { ReactNode } from 'react';

export function NavLink({ href, children }: { href: string; children: ReactNode }) {
  const path = usePathname();
  const active = path === href || (href !== '/admin' && href !== '/dashboard' && path.startsWith(href + '/'));
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={clsx('block rounded-md px-3 py-2 text-sm transition-colors', active ? 'bg-surface-3 text-fg' : 'text-fg-muted hover:bg-surface-2 hover:text-fg')}
    >
      {children}
    </Link>
  );
}
