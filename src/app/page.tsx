import type { Metadata } from 'next';
import { Hero } from '@/components/landing/hero';
import { FactStrip, Faq, FinalCta, Footer, HowItWorks, NavExplainer, NetworksAndStatus, Pillars, Security, WithdrawalControls } from '@/components/landing/sections';
import { redirect } from 'next/navigation';
import { getSessionUser } from '@/server/http/auth';
import { realFundsActive } from '@/server/phase-guard';

export const metadata: Metadata = {
  title: { absolute: 'EliteWhale (Testnet) · Auditable USDT investment ledger' },
  description:
    'Testnet demonstration of a USDT investment ledger: double-entry balances, unitized NAV from trade executions, and policy-gated withdrawals. No real funds.',
  openGraph: {
    title: 'EliteWhale (Testnet)',
    description: 'Follow every test USDT through an auditable investment ledger. Simulated trading venue, no real funds.',
    type: 'website',
  },
};

export default async function LandingPage() {
  const user = await getSessionUser().catch(() => null);
  const signedIn = !!user;
  // A private group with real money has no public marketing page (it describes the testnet product).
  if (realFundsActive()) redirect(signedIn ? '/dashboard' : '/login');

  return (
    <div className="landing" style={{ fontFamily: 'var(--font-body)', color: 'var(--color-text)', background: 'var(--color-login-bg)' }}>
      <Hero signedIn={signedIn} />
      <main>
        <FactStrip />
        <HowItWorks />
        <Pillars />
        <NavExplainer />
        <WithdrawalControls />
        <Security />
        <NetworksAndStatus />
        <Faq />
        <FinalCta signedIn={signedIn} />
      </main>
      <Footer />
    </div>
  );
}
