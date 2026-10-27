import Link from 'next/link';
import type { ReactNode } from 'react';
import { LogoMark } from '@/components/landing/hero';
import { NavLink, type NavIcon } from './nav-link';
import { MobileNav } from './mobile-nav';
import { SignOutButton } from './sign-out-button';
import { serverEnv } from '@/server/env';
import { realFundsActive } from '@/server/phase-guard';

type NavItem = { href: string; label: string; icon: NavIcon };

const USER_NAV: NavItem[] = [
  { href: '/dashboard', label: 'Overview', icon: 'overview' },
  { href: '/portfolio', label: 'Portfolio & performance', icon: 'portfolio' },
  { href: '/deposit', label: 'Deposit', icon: 'deposit' },
  { href: '/withdraw', label: 'Withdraw', icon: 'withdraw' },
  { href: '/transactions', label: 'Transactions', icon: 'transactions' },
  { href: '/referrals', label: 'Referrals', icon: 'referrals' },
  { href: '/settings', label: 'Profile', icon: 'profile' },
  { href: '/settings/security', label: 'Security', icon: 'security' },
  { href: '/support', label: 'Support & FAQ', icon: 'support' },
];

const ADMIN_NAV: NavItem[] = [
  { href: '/admin', label: 'Overview', icon: 'console' },
  { href: '/admin/approvals', label: 'Sign-up approvals', icon: 'approvals' },
  { href: '/admin/users', label: 'Users', icon: 'users' },
  { href: '/admin/referrals', label: 'Referrals', icon: 'referrals' },
  { href: '/admin/off-platform', label: 'Off-platform ledger', icon: 'ledger' },
  { href: '/admin/deposits', label: 'Deposits', icon: 'deposit' },
  { href: '/admin/withdrawals', label: 'Withdrawals', icon: 'withdraw' },
  { href: '/admin/trading', label: 'Trading & allocation', icon: 'trading' },
  { href: '/admin/treasury', label: 'Treasury & reconciliation', icon: 'treasury' },
  { href: '/admin/compliance', label: 'Compliance review', icon: 'compliance' },
  { href: '/admin/audit', label: 'Audit log', icon: 'audit' },
];

/** The homepage logo: mark, wordmark and testnet pill. */
export function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2.5" aria-label="EliteWhale home">
      <span className="[--color-text:var(--color-fg)]">
        <LogoMark size={26} />
      </span>
      <span className="text-base font-semibold tracking-tight">EliteWhale</span>
      {realFundsActive() ? null : (
        <span className="rounded-full border border-fg/20 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-fg-muted">testnet</span>
      )}
    </Link>
  );
}

function Avatar({ email }: { email: string }) {
  return (
    <span aria-hidden className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-[#7342e2] to-[#a07cf4] text-xs font-semibold uppercase text-white">
      {email.slice(0, 1)}
    </span>
  );
}

export function AppShell({ children, email, isStaff, variant = 'user' }: { children: ReactNode; email: string; isStaff: boolean; variant?: 'user' | 'admin' }) {
  // Group mode has no investment pool, so its pages are hidden.
  const hidden = serverEnv().GROUP_MODE ? ['/portfolio', '/admin/trading'] : [];
  const nav = (variant === 'admin' ? ADMIN_NAV : USER_NAV).filter((n) => !hidden.includes(n.href));
  const switchLink = isStaff ? (variant === 'admin' ? { href: '/dashboard', label: '← Customer view' } : { href: '/admin', label: 'Staff console →' }) : undefined;
  return (
    <div className="mx-auto flex min-h-[calc(100vh-30px)] max-w-[1440px] gap-6 lg:px-4 lg:py-4">
      <aside className="sticky top-4 hidden h-[calc(100vh-62px)] w-64 shrink-0 flex-col rounded-[var(--radius-card)] bg-white/70 px-3 py-5 ring-1 ring-black/5 backdrop-blur-md lg:flex">
        <div className="px-3">
          <Logo />
        </div>
        {variant === 'admin' ? <p className="mx-3 mt-5 w-fit rounded-full bg-warn/10 px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wider text-warn">Staff console</p> : null}
        <nav aria-label={variant === 'admin' ? 'Admin' : 'Account'} className="mt-6 space-y-0.5 overflow-y-auto">
          {nav.map((n) => (
            <NavLink key={n.href} href={n.href} icon={n.icon}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto space-y-2 border-t border-line pt-3">
          {switchLink ? (
            <NavLink href={switchLink.href} icon="console">
              {switchLink.label}
            </NavLink>
          ) : null}
          <div className="flex items-center gap-2.5 rounded-xl px-3 py-2">
            <Avatar email={email} />
            <span className="min-w-0 flex-1 truncate text-xs text-fg-muted" title={email}>
              {email}
            </span>
          </div>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-line/70 bg-bg/80 px-4 py-3 backdrop-blur-md sm:px-6 lg:static lg:rounded-[var(--radius-card)] lg:border-0 lg:bg-transparent lg:px-2 lg:py-1 lg:backdrop-blur-none">
          <MobileNav nav={nav} extra={switchLink} />
          <div className="lg:hidden">
            <Logo />
          </div>
          <div className="ml-auto flex items-center gap-3 text-sm text-fg-muted">
            {variant === 'admin' ? <span className="rounded-full bg-warn/10 px-2.5 py-0.5 text-xs text-warn lg:hidden">Staff</span> : null}
            <span className="hidden max-w-[220px] truncate sm:inline lg:hidden">{email}</span>
            <SignOutButton />
          </div>
        </header>
        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-2 lg:py-4">{children}</main>
      </div>
    </div>
  );
}
