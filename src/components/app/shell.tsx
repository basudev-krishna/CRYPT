import Link from 'next/link';
import type { ReactNode } from 'react';
import { NavLink } from './nav-link';
import { SignOutButton } from './sign-out-button';

const USER_NAV = [
  { href: '/dashboard', label: 'Overview' },
  { href: '/portfolio', label: 'Portfolio & performance' },
  { href: '/deposit', label: 'Deposit' },
  { href: '/withdraw', label: 'Withdraw' },
  { href: '/transactions', label: 'Transactions' },
  { href: '/settings', label: 'Profile & verification' },
  { href: '/settings/security', label: 'Security' },
  { href: '/disclosures', label: 'Risk disclosures' },
  { href: '/support', label: 'Support & FAQ' },
];

const ADMIN_NAV = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/deposits', label: 'Deposits' },
  { href: '/admin/withdrawals', label: 'Withdrawals' },
  { href: '/admin/trading', label: 'Trading & allocation' },
  { href: '/admin/treasury', label: 'Treasury & reconciliation' },
  { href: '/admin/compliance', label: 'Compliance review' },
  { href: '/admin/audit', label: 'Audit log' },
];

export function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
      <span aria-hidden className="grid h-7 w-7 place-items-center rounded-md bg-gradient-to-br from-accent to-accent-strong text-xs font-bold text-white">
        EW
      </span>
      <span>EliteWhale</span>
      <span className="rounded border border-sim/40 px-1.5 text-[10px] font-medium uppercase tracking-wider text-sim">testnet</span>
    </Link>
  );
}

export function AppShell({ children, email, isStaff, variant = 'user' }: { children: ReactNode; email: string; isStaff: boolean; variant?: 'user' | 'admin' }) {
  const nav = variant === 'admin' ? ADMIN_NAV : USER_NAV;
  return (
    <div className="mx-auto flex min-h-[calc(100vh-30px)] max-w-[1400px]">
      <aside className="hidden w-60 shrink-0 border-r border-line/70 px-4 py-6 lg:block">
        <Logo />
        <nav aria-label={variant === 'admin' ? 'Admin' : 'Account'} className="mt-8 space-y-0.5">
          {nav.map((n) => (
            <NavLink key={n.href} href={n.href}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        {isStaff ? (
          <div className="mt-8 border-t border-line/70 pt-4">
            <NavLink href={variant === 'admin' ? '/dashboard' : '/admin'}>{variant === 'admin' ? '← Customer view' : 'Staff console →'}</NavLink>
          </div>
        ) : null}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-line/70 px-4 py-3 sm:px-8">
          <div className="lg:hidden">
            <Logo />
          </div>
          <MobileNav nav={nav} />
          <div className="ml-auto flex items-center gap-3 text-sm text-fg-muted">
            {variant === 'admin' ? <span className="rounded bg-warn/10 px-2 py-0.5 text-xs text-warn">Staff console</span> : null}
            <span className="hidden sm:inline">{email}</span>
            <SignOutButton />
          </div>
        </header>
        <main className="flex-1 px-4 py-6 sm:px-8 sm:py-8">{children}</main>
      </div>
    </div>
  );
}

function MobileNav({ nav }: { nav: { href: string; label: string }[] }) {
  return (
    <details className="relative lg:hidden">
      <summary className="cursor-pointer list-none rounded-md border border-line px-3 py-1.5 text-sm text-fg-muted">Menu</summary>
      <nav className="absolute left-0 z-20 mt-2 w-60 rounded-lg border border-line bg-surface p-2 shadow-xl">
        {nav.map((n) => (
          <NavLink key={n.href} href={n.href}>
            {n.label}
          </NavLink>
        ))}
      </nav>
    </details>
  );
}
