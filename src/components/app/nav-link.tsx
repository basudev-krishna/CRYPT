'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import { motion } from 'framer-motion';
import {
  ArrowLeftRight,
  ArrowDownToLine,
  ArrowUpFromLine,
  BookOpenCheck,
  Gift,
  Gauge,
  KeyRound,
  Landmark,
  LayoutDashboard,
  LineChart,
  ScrollText,
  ShieldCheck,
  UserCheck,
  UserRound,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';

/** Icons by name, so server components can pick one without passing a component across the boundary. */
export const NAV_ICONS = {
  overview: LayoutDashboard,
  portfolio: LineChart,
  deposit: ArrowDownToLine,
  withdraw: ArrowUpFromLine,
  transactions: ArrowLeftRight,
  profile: UserRound,
  security: KeyRound,
  console: Gauge,
  users: Users,
  approvals: UserCheck,
  referrals: Gift,
  trading: LineChart,
  treasury: Landmark,
  compliance: ShieldCheck,
  audit: ScrollText,
  ledger: BookOpenCheck,
} satisfies Record<string, LucideIcon>;
export type NavIcon = keyof typeof NAV_ICONS;

export function isActive(path: string, href: string) {
  return path === href || (href !== '/admin' && href !== '/dashboard' && path.startsWith(href + '/'));
}

export function NavLink({ href, icon, children, onNavigate }: { href: string; icon?: NavIcon; children: ReactNode; onNavigate?: () => void }) {
  const path = usePathname();
  const active = isActive(path, href);
  const Icon = icon ? NAV_ICONS[icon] : null;
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={clsx('group relative flex items-center gap-3 rounded-xl px-3 py-2 text-sm transition-colors', active ? 'text-accent' : 'text-fg-muted hover:text-fg')}
    >
      {active ? <motion.span layoutId="nav-active" className="absolute inset-0 rounded-xl bg-accent/10" transition={{ type: 'spring', stiffness: 420, damping: 34 }} /> : null}
      {Icon ? <Icon size={17} aria-hidden className="relative shrink-0 transition-transform group-hover:scale-110" /> : null}
      <span className="relative">{children}</span>
    </Link>
  );
}
