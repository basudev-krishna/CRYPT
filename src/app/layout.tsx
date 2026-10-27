import type { Metadata, Viewport } from 'next';
import { Inter, Inter_Tight, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { realFundsActive } from '@/server/phase-guard';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jbmono', display: 'swap' });
// Self-hosted at build time; landing-page headings only.
const display = Inter_Tight({ subsets: ['latin'], weight: '700', variable: '--font-display', display: 'swap' });

export const metadata: Metadata = realFundsActive()
  ? {
      title: { default: 'EliteWhale', template: '%s · EliteWhale' },
      description: 'Private members’ ledger for a USDT group wallet on BNB Smart Chain.',
      robots: { index: false, follow: false },
    }
  : {
      title: { default: 'EliteWhale (Testnet)', template: '%s · EliteWhale (Testnet)' },
      description: 'Testnet demonstration of an auditable USDT investment ledger. No real funds.',
      robots: { index: false, follow: false },
    };

export const viewport: Viewport = { themeColor: '#f2f2ee', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable} ${display.variable}`}>
      <body className="min-h-screen" style={{ fontFamily: 'var(--font-inter), var(--font-sans)' }}>
        <EnvironmentBanner />
        {children}
      </body>
    </html>
  );
}

/** Testnet only: says plainly that nothing here is real money. The live group site shows no banner. */
function EnvironmentBanner() {
  if (realFundsActive()) return null;
  return (
    <div className="border-b border-sim/30 bg-sim/10 px-4 py-1.5 text-center text-xs text-sim">
      <strong className="font-semibold">Testnet demonstration.</strong> Balances, deposits and trading results are simulated or on test networks.
      No real funds are accepted, held or paid out.
    </div>
  );
}
