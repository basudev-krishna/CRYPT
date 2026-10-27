import type { Metadata } from 'next';
import { Hero } from '@/components/landing/hero';
import { FactStrip, FinalCta, Footer, GroupStatus, HowItWorks, NavExplainer, NetworksAndStatus, Pillars, Security, WithdrawalControls } from '@/components/landing/sections';
import { getSessionUser } from '@/server/http/auth';
import { realFundsActive } from '@/server/phase-guard';

export function generateMetadata(): Metadata {
  if (realFundsActive()) {
    return {
      title: { absolute: 'EliteWhale · Private USDT investment group' },
      description: 'A private USDT investment group on BNB Smart Chain, run on an auditable double-entry ledger. New members are approved by the administrator.',
      openGraph: { title: 'EliteWhale', description: 'A private USDT investment group run on an auditable ledger.', type: 'website' },
    };
  }
  return {
    title: { absolute: 'EliteWhale (Testnet) · Auditable USDT investment ledger' },
    description:
      'Testnet demonstration of a USDT investment ledger: double-entry balances, unitized NAV from trade executions, and policy-gated withdrawals. No real funds.',
    openGraph: {
      title: 'EliteWhale (Testnet)',
      description: 'Follow every test USDT through an auditable investment ledger. Simulated trading venue, no real funds.',
      type: 'website',
    },
  };
}

export default async function LandingPage() {
  const user = await getSessionUser().catch(() => null);
  const signedIn = !!user;
  // The private group gets its own copy: the testnet wording ("no real funds") would be false there.
  const realFunds = realFundsActive();

  return (
    <div className="landing" style={{ fontFamily: 'var(--font-body)', color: 'var(--color-text)', background: 'var(--color-login-bg)' }}>
      <Hero signedIn={signedIn} realFunds={realFunds} />
      <main>
        <FactStrip />
        <HowItWorks realFunds={realFunds} />
        <Pillars />
        <NavExplainer />
        <WithdrawalControls />
        <Security />
        {realFunds ? <GroupStatus /> : <NetworksAndStatus />}
        <FinalCta signedIn={signedIn} realFunds={realFunds} />
      </main>
      <Footer realFunds={realFunds} />
    </div>
  );
}
