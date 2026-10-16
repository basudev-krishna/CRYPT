import type { Metadata } from 'next';
import { PublicShell } from '@/components/app/public-shell';
import { Card } from '@/components/ui/primitives';

export const metadata: Metadata = { title: 'Support & FAQ' };

const FAQ: [string, string][] = [
  ['Is this real money?', 'No. This build runs on test networks and a simulated trading venue. Test tokens have no value, and mainnet networks are disabled in the code.'],
  ['Why is my deposit not credited yet?', 'Deposits are credited after the network’s required confirmations and compliance checks. Deposits below the minimum, from high-risk addresses, or before identity verification are held for review instead of being credited automatically.'],
  ['I sent tokens on the wrong network or a different token.', 'Those transfers are not credited automatically. Contact support with the transaction hash; the operations team can investigate it through a controlled recovery procedure.'],
  ['How is my return calculated?', 'You own units of a pool. Each valuation, the pool is valued from its actual trade executions and market prices, fees are deducted, and NAV per unit is struck. Your result is your units multiplied by the change in NAV per unit. There are no fixed rates.'],
  ['Why can’t I withdraw my whole account value?', 'Only your available (uninvested) balance can be withdrawn. To withdraw invested funds, redeem units first; redemptions execute at the next NAV strike and the proceeds become available.'],
  ['Why is my withdrawal on hold?', 'Withdrawals to a new address have a short cooldown, large amounts are reviewed by compliance, and payouts pause automatically if treasury reconciliation finds a discrepancy or operations activate an emergency pause. Reserved funds stay in your account.'],
  ['What fees apply?', 'A management fee and a performance fee above a high-water mark are deducted inside the NAV, and a fixed fee applies per withdrawal. All fee rules are versioned and shown in the app.'],
  ['How do I raise a complaint?', 'Email the support team with your account email and any transaction hashes. Complaints are logged, acknowledged and tracked to resolution; you may escalate if you are not satisfied with the response.'],
];

export default function SupportPage() {
  return (
    <PublicShell>
      <div className="mx-auto max-w-3xl py-10">
        <h1 className="text-3xl font-semibold tracking-tight">Support & FAQ</h1>
        <div className="mt-8 space-y-3">
          {FAQ.map(([q, a]) => (
            <details key={q} className="group rounded-[var(--radius-card)] border border-line bg-surface/80 px-5 py-4">
              <summary className="cursor-pointer list-none font-medium marker:hidden">
                <span className="mr-2 text-fg-subtle group-open:rotate-90">›</span>
                {q}
              </summary>
              <p className="mt-3 text-sm text-fg-muted">{a}</p>
            </details>
          ))}
        </div>
        <Card className="mt-8 text-sm text-fg-muted">
          <h2 className="mb-2 font-medium text-fg">Contact</h2>
          <p>Support contact details are configured per deployment. For this testnet build, contact the project maintainers.</p>
        </Card>
      </div>
    </PublicShell>
  );
}
