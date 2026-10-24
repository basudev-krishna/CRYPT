import { BadgeCheck, BookLock, ShieldCheck, Users } from 'lucide-react';
import { Logo } from '@/components/app/shell';
import { realFundsActive } from '@/server/phase-guard';

// Factual product points only: no member counts, payout totals or return claims.
const FEATURES = [
  { icon: BookLock, title: 'Ledger-backed balances', text: 'Every balance comes from a double-entry ledger you can audit.' },
  { icon: Users, title: 'Approved members', text: 'Each new account is reviewed by an administrator before use.' },
  { icon: ShieldCheck, title: 'Two-factor security', text: 'Authenticator-app codes protect sign-in and withdrawals.' },
  realFundsActive()
    ? { icon: BadgeCheck, title: 'Real USDT', text: 'BEP20 USDT on BNB Smart Chain, in a group wallet the administrator controls.' }
    : { icon: BadgeCheck, title: 'Testnet only', text: 'A demonstration with test tokens. No real funds are accepted.' },
];

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-[calc(100vh-30px)] lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <aside className="relative hidden overflow-hidden border-r border-line/70 bg-gradient-to-br from-accent/20 via-surface to-bg px-12 py-12 lg:flex lg:flex-col">
        <div aria-hidden className="pointer-events-none absolute -right-24 -top-24 h-80 w-80 rounded-full bg-accent/20 blur-3xl" />
        <Logo />
        <div className="relative my-auto max-w-md py-12">
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-accent">Welcome to EliteWhale</p>
          <h2 className="mt-3 text-4xl font-semibold leading-tight tracking-tight">A transparent, member-only investment ledger.</h2>
          <p className="mt-4 text-sm text-fg-muted">
            {realFundsActive()
              ? 'Deposit USDT from your registered wallet, see your share in an auditable ledger, and withdraw under clear policy checks.'
              : 'Deposit test USDT, follow a pooled portfolio valued from real trade records, and withdraw under clear policy checks.'}
          </p>
          <ul className="mt-10 grid gap-4 sm:grid-cols-2">
            {FEATURES.map(({ icon: Icon, title, text }) => (
              <li key={title} className="rounded-[var(--radius-card)] border border-line bg-surface-2/60 p-4">
                <Icon size={20} className="text-accent" aria-hidden />
                <p className="mt-3 text-sm font-medium">{title}</p>
                <p className="mt-1 text-xs text-fg-muted">{text}</p>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-fg-subtle">Not investment advice. Returns are not guaranteed and you may lose money.</p>
      </aside>
      <main className="flex flex-col justify-center px-4 py-12 sm:px-8">
        <div className="mx-auto w-full max-w-lg">
          <div className="mb-8 flex justify-center lg:hidden">
            <Logo />
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
