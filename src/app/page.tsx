import { PublicShell } from '@/components/app/public-shell';
import { ButtonLink, Card } from '@/components/ui/primitives';

const PILLARS = [
  {
    title: 'Ledger-derived balances',
    body: 'Every balance is computed from an immutable double-entry ledger. Corrections are visible reversal entries, never silent edits.',
  },
  {
    title: 'Deposits credited exactly once',
    body: 'Transfers are verified on chain against an explicit token allowlist and credited only after the required confirmations and compliance checks.',
  },
  {
    title: 'Results from real executions',
    body: 'Performance is calculated from imported trade executions and market prices using a unitized NAV. No fixed rates, no scheduled balance increases. Losses are shown.',
  },
  {
    title: 'Policy-gated withdrawals',
    body: 'Payouts are automated only when limits, address screening, liquidity and reconciliation checks all pass, with step-up authentication.',
  },
];

export default function LandingPage() {
  return (
    <PublicShell>
      <section className="py-16 sm:py-24">
        <p className="mb-4 inline-flex rounded-full border border-sim/40 bg-sim/10 px-3 py-1 text-xs text-sim">Testnet MVP · simulated trading venue</p>
        <h1 className="max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">An auditable USDT investment ledger, built for transparency.</h1>
        <p className="mt-5 max-w-2xl text-lg text-fg-muted">
          Deposit test USDT, follow how pooled investment results are valued and allocated, and withdraw under clearly defined rules. This build runs on test networks with
          simulated trading data so the accounting can be inspected end to end.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <ButtonLink href="/register">Create a testnet account</ButtonLink>
          <ButtonLink href="/disclosures" variant="secondary">Read the risk disclosure</ButtonLink>
        </div>
        <p className="mt-6 max-w-2xl text-sm text-fg-subtle">
          Returns are never guaranteed. Investment values can fall as well as rise, and you can lose some or all of the amount invested.
        </p>
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        {PILLARS.map((p) => (
          <Card key={p.title}>
            <h2 className="font-medium">{p.title}</h2>
            <p className="mt-2 text-sm text-fg-muted">{p.body}</p>
          </Card>
        ))}
      </section>

      <section className="mt-16">
        <Card>
          <h2 className="font-medium">What this build is not</h2>
          <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm text-fg-muted">
            <li>It does not accept, hold or pay out real funds. Mainnet networks are disabled in code.</li>
            <li>The trading venue is a simulator; its results are labelled “simulated” everywhere they appear.</li>
            <li>It has not been licensed, independently audited or penetration tested. See the production-readiness checklist in the repository.</li>
          </ul>
        </Card>
      </section>
    </PublicShell>
  );
}
