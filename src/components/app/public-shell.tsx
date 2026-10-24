import Link from 'next/link';
import type { ReactNode } from 'react';
import { Logo } from './shell';
import { getSessionUser } from '@/server/http/auth';
import { realFundsActive } from '@/server/phase-guard';

export async function PublicShell({ children }: { children: ReactNode }) {
  const user = await getSessionUser().catch(() => null);
  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-8">
      <header className="flex items-center justify-between py-5">
        <Logo />
        <nav className="flex items-center gap-1 text-sm">
          <Link href="/disclosures" className="rounded-full px-3 py-2 text-fg-muted transition hover:bg-white hover:text-fg">Risk disclosure</Link>
          <Link href="/support" className="rounded-full px-3 py-2 text-fg-muted transition hover:bg-white hover:text-fg">FAQ</Link>
          {user ? (
            <Link href="/dashboard" className="rounded-full bg-accent px-4 py-2 font-medium text-white transition hover:-translate-y-px hover:bg-accent-strong">Open app</Link>
          ) : (
            <>
              <Link href="/login" className="rounded-full px-3 py-2 text-fg-muted transition hover:bg-white hover:text-fg">Sign in</Link>
              <Link href="/register" className="rounded-full bg-accent px-4 py-2 font-medium text-white transition hover:-translate-y-px hover:bg-accent-strong">Create account</Link>
            </>
          )}
        </nav>
      </header>
      <main>{children}</main>
      <footer className="mt-24 flex flex-wrap justify-between gap-4 border-t border-line py-8 text-xs text-fg-subtle">
        <p>
          {realFundsActive()
            ? 'Private members’ group. Not a licensed investment, banking or custody service. No return is promised.'
            : 'Testnet demonstration software. Not an offer of investment services. No real funds are accepted.'}
        </p>
        <div className="flex gap-4">
          <Link href="/disclosures" className="hover:text-fg">Risk disclosure</Link>
          <Link href="/support" className="hover:text-fg">Support</Link>
        </div>
      </footer>
    </div>
  );
}
