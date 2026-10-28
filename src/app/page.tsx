import type { Metadata } from 'next';
import { Hero } from '@/components/landing/hero';
import { AboutEliteWhale, Footer, NetworksAndStatus, RevenueModel, Roadmap, Support, UpcomingProjects, VideoShowcase } from '@/components/landing/sections';
import { getSessionUser } from '@/server/http/auth';
import { realFundsActive } from '@/server/phase-guard';

export function generateMetadata(): Metadata {
  if (realFundsActive()) {
    return {
      title: { absolute: 'EliteWhale · The Next Generation Era' },
      description: 'A Web3 ecosystem built for real utility, transparent trading and sustainable digital-asset participation.',
      openGraph: {
        title: 'EliteWhale · The Next Generation Era',
        description: 'A Web3 ecosystem built for real utility, transparent trading and sustainable digital-asset participation.',
        type: 'website',
      },
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
        <VideoShowcase />
        <AboutEliteWhale />
        <Roadmap />
        <UpcomingProjects />
        <RevenueModel />
        {realFunds ? null : <NetworksAndStatus />}
        <Support />
      </main>
      <Footer realFunds={realFunds} />
    </div>
  );
}
