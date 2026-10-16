import type { Metadata } from 'next';
import { PublicShell } from '@/components/app/public-shell';
import { Card } from '@/components/ui/primitives';
import { AcceptDisclosure } from '@/components/app/actions';
import { getSessionUser } from '@/server/http/auth';
import { webDb } from '@/server/db';
import { getProfile } from '@/server/queries/user';
import { RISK_DISCLOSURE_VERSION } from '@/lib/disclosures';

export const metadata: Metadata = { title: 'Investment details & risk disclosure' };

export default async function DisclosuresPage() {
  const user = await getSessionUser().catch(() => null);
  const profile = user ? await getProfile(webDb(), user.id) : null;
  return (
    <PublicShell>
      <article className="mx-auto max-w-3xl py-10">
        <h1 className="text-3xl font-semibold tracking-tight">Investment details & risk disclosure</h1>
        <p className="mt-2 text-sm text-fg-subtle">Version {RISK_DISCLOSURE_VERSION}</p>

        <Card className="mt-8 space-y-4 text-sm leading-relaxed text-fg-muted">
          <h2 className="text-base font-medium text-fg">1. Status of this service</h2>
          <p>This is a testnet demonstration. It uses test tokens with no monetary value and a simulated trading venue. It is not an offer, solicitation or recommendation to invest, and the operator is not licensed to provide investment services.</p>

          <h2 className="text-base font-medium text-fg">2. How the pool works</h2>
          <p>Customer funds that are invested are pooled. Each investor holds units. The pool&apos;s net asset value (NAV) equals the market value of its holdings and cash at the trading venue, minus accrued fees. NAV per unit is struck at each valuation. Subscriptions and redemptions execute at the next NAV per unit after your request (forward pricing). Conversions round down in favour of the pool.</p>

          <h2 className="text-base font-medium text-fg">3. Fees</h2>
          <p>Fees are set by versioned policy and deducted inside the NAV: a management fee accrued pro rata to time, and a performance fee charged only on gains above the previous high-water mark. A fixed fee applies to each withdrawal. Current values are shown on the withdrawal page and in your allocation history.</p>

          <h2 className="text-base font-medium text-fg">4. Key risks</h2>
          <ul className="list-disc space-y-1.5 pl-5">
            <li><strong className="text-fg">Loss of capital.</strong> Trading results can be negative. The value of your units can fall below what you paid, and you can lose all of it.</li>
            <li><strong className="text-fg">No guarantee.</strong> No return is promised. Past or simulated performance does not indicate future results.</li>
            <li><strong className="text-fg">Stablecoin risk.</strong> USDT may lose its peg, be frozen by its issuer, or become unavailable on a network.</li>
            <li><strong className="text-fg">Custody and counterparty risk.</strong> Assets are held by the operator through custody providers and trading venues that may fail, be hacked or restrict withdrawals.</li>
            <li><strong className="text-fg">Liquidity and operational risk.</strong> Withdrawals may be delayed by reviews, limits, reconciliation holds, network congestion or emergency pauses.</li>
            <li><strong className="text-fg">Network risk.</strong> Tokens sent on the wrong network or to the wrong address may be unrecoverable.</li>
            <li><strong className="text-fg">Regulatory and tax risk.</strong> Laws on virtual digital assets (including in India) may restrict this activity or impose taxes, withholding and reporting obligations on you.</li>
          </ul>

          <h2 className="text-base font-medium text-fg">5. Your information</h2>
          <p>Identity details are used for verification, anti-money-laundering checks and record keeping as required by law, and are retained for the required period.</p>
        </Card>

        {user ? (
          <Card className="mt-6">
            <AcceptDisclosure version={RISK_DISCLOSURE_VERSION} accepted={profile?.riskDisclosureVersion === RISK_DISCLOSURE_VERSION} />
          </Card>
        ) : null}
      </article>
    </PublicShell>
  );
}
