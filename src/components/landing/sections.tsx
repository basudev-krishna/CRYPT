import Link from 'next/link';
import {
  ArrowRight,
  ArrowRightCircle,
  BadgeCheck,
  BookLock,
  Calculator,
  CircleDollarSign,
  FileClock,
  Gauge,
  KeyRound,
  Landmark,
  Layers,
  LineChart,
  ListChecks,
  PauseCircle,
  Scale,
  ScanSearch,
  ShieldCheck,
  Undo2,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { LogoMark } from './hero';

/*
 * Marketing sections for the public landing page. Server components only: the
 * copy describes behaviour that exists in this repository, so keep it in step
 * with the code (seed networks, withdrawal policy checks, docs/accounting.md).
 */

const container = 'mx-auto max-w-[1280px] px-5 sm:px-8';
const card = 'rounded-3xl bg-white/70 ring-1 ring-black/5';
const headingStyle = { fontFamily: 'var(--font-heading)', lineHeight: 1.1, letterSpacing: '-0.01em' } as const;

function SectionHeader({ eyebrow, title, intro }: { eyebrow: string; title: string; intro?: string }) {
  return (
    <header className="max-w-2xl">
      <p className="text-xs font-semibold uppercase tracking-[0.14em]" style={{ color: 'var(--color-accent)' }}>
        {eyebrow}
      </p>
      <h2 className="mt-3" style={{ ...headingStyle, fontSize: 'clamp(1.5rem, 3.5vw, 2.4rem)' }}>
        {title}
      </h2>
      {intro ? <p className="mt-4 text-[15px] leading-relaxed opacity-75 sm:text-base">{intro}</p> : null}
    </header>
  );
}

function IconBadge({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="inline-flex h-10 w-10 items-center justify-center rounded-2xl" style={{ background: 'rgba(115,66,226,0.1)', color: 'var(--color-accent)' }}>
      <Icon size={20} aria-hidden />
    </span>
  );
}

/* ------------------------------------------------------------------ facts */

const FACTS = [
  { value: '0', label: 'floating-point operations on money', note: 'bigint base units, 18-dp fixed point' },
  { value: '100%', label: 'of balances derived from the journal', note: 'double-entry, append-only' },
  { value: '1×', label: 'credit per deposit, however often it is retried', note: 'deterministic idempotency keys' },
  { value: '4-eyes', label: 'on every staff action', note: 'AAL2, audit record, no self-review' },
];

export function FactStrip() {
  return (
    <section aria-label="Key facts" className="border-y border-black/10 bg-white/50">
      <dl className={`${container} grid grid-cols-2 gap-x-6 gap-y-8 py-10 lg:grid-cols-4`}>
        {FACTS.map((f) => (
          <div key={f.label}>
            <dt className="sr-only">{f.label}</dt>
            <dd>
              <span className="block text-3xl sm:text-4xl" style={headingStyle}>
                {f.value}
              </span>
              <span className="mt-2 block text-sm font-medium">{f.label}</span>
              <span className="mt-1 block text-xs opacity-60">{f.note}</span>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/* ----------------------------------------------------------- how it works */

const STEPS: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: Wallet,
    title: 'Deposit test USDT',
    body: 'Send an allowlisted test token to your personal deposit address. It is held in suspense until it has enough confirmations and has passed screening, and only then is it credited to your available balance.',
  },
  {
    icon: Layers,
    title: 'Subscribe to the pool',
    body: 'Move available funds into the pooled investment. You receive units at the next NAV per unit after your request (forward pricing), rounded down in favour of the pool.',
  },
  {
    icon: LineChart,
    title: 'Track valued results',
    body: 'At each valuation the pool is marked to market from imported trade executions and prices, and fees are accrued inside the NAV. Your result is your units × the change in NAV per unit.',
  },
  {
    icon: CircleDollarSign,
    title: 'Redeem and withdraw',
    body: 'Redeem units back to your available balance, then request a withdrawal. Funds are reserved immediately and paid out only after every policy check passes.',
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className={`${container} scroll-mt-8 py-20 sm:py-28`}>
      <SectionHeader
        eyebrow="How it works"
        title="Four steps, each one a ledger entry you can inspect."
        intro="Every step below posts a balanced journal entry. Your dashboard, statements and the operator's treasury view all read from the same journal."
      />
      <ol className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((s, i) => (
          <li key={s.title} className={`${card} relative p-7`}>
            <div className="flex items-center justify-between">
              <IconBadge icon={s.icon} />
              <span className="text-xs font-semibold tabular-nums opacity-40">0{i + 1}</span>
            </div>
            <h3 className="mt-5 text-lg font-semibold">{s.title}</h3>
            <p className="mt-2 text-[15px] leading-relaxed opacity-75">{s.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

/* ---------------------------------------------------------------- pillars */

const PILLARS: { id: string; icon: LucideIcon; title: string; body: string; points: string[] }[] = [
  {
    id: 'ledger',
    icon: BookLock,
    title: 'Ledger-derived balances',
    body: 'Every balance is computed from an immutable double-entry ledger. Corrections are visible reversal entries, never silent edits.',
    points: ['Journal rows cannot be updated or deleted at the database-grant level', 'Integrity check: every token balances, every cache matches the journal', 'Each entry carries a business idempotency key'],
  },
  {
    id: 'deposits',
    icon: ScanSearch,
    title: 'Deposits credited exactly once',
    body: 'Transfers are verified on chain against an explicit token allowlist and credited only after the required confirmations and compliance checks.',
    points: ['Unsupported tokens and below-minimum amounts are held, not credited', 'Transfers reorged out before credit are never credited; reappearing ones go to manual recovery', 'Unverified accounts are held for review'],
  },
  {
    id: 'performance',
    icon: Calculator,
    title: 'Results from real executions',
    body: 'Performance is calculated from imported trade executions and market prices using a unitized NAV. No fixed rates, no scheduled balance increases. Losses are shown.',
    points: ['Missing or stale prices stop the valuation instead of guessing', 'Realized, unrealized and fee effects are reported separately', 'Simulated venue results are labelled as simulated'],
  },
  {
    id: 'withdrawals',
    icon: ShieldCheck,
    title: 'Policy-gated withdrawals',
    body: 'Payouts are automated only when limits, address screening, liquidity and reconciliation checks all pass, with step-up authentication.',
    points: ['Funds are reserved under a row lock before any payout starts', 'Retried payouts reuse the same custody request key', 'Any custody or chain disagreement pauses payouts'],
  },
];

export function Pillars() {
  return (
    <section id="principles" className="scroll-mt-8 bg-white/40 py-20 sm:py-28">
      <div className={container}>
        <SectionHeader eyebrow="Principles" title="Built so the numbers can be checked." />
        <div className="mt-12 grid gap-4 sm:grid-cols-2">
          {PILLARS.map((p) => (
            <article key={p.id} id={p.id} className={`${card} scroll-mt-8 p-7`}>
              <IconBadge icon={p.icon} />
              <h3 className="mt-5 text-lg font-semibold">{p.title}</h3>
              <p className="mt-2 text-[15px] leading-relaxed opacity-75">{p.body}</p>
              <ul className="mt-5 space-y-2 border-t border-black/5 pt-5 text-sm">
                {p.points.map((pt) => (
                  <li key={pt} className="flex gap-2.5">
                    <BadgeCheck size={16} className="mt-0.5 shrink-0" style={{ color: 'var(--color-accent)' }} aria-hidden />
                    <span className="opacity-80">{pt}</span>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------ NAV example */

const NAV_ROWS: { label: string; value: string; emphasis?: boolean }[] = [
  { label: 'Units outstanding', value: '100,000.00' },
  { label: 'NAV per unit at the previous strike', value: '1.000000' },
  { label: 'Gross asset value after trading', value: '102,000.00 USDT' },
  { label: 'Management fee accrued (e.g. 2% p.a., 1 day)', value: '− 5.59 USDT' },
  { label: 'Performance fee (10% of gain above high-water mark)', value: '− 199.44 USDT' },
  { label: 'Net asset value', value: '101,794.97 USDT' },
  { label: 'New NAV per unit', value: '1.017950', emphasis: true },
];

export function NavExplainer() {
  return (
    <section id="nav" className={`${container} scroll-mt-8 py-20 sm:py-28`}>
      <div className="grid items-start gap-12 lg:grid-cols-[1fr_1.1fr]">
        <div>
          <SectionHeader
            eyebrow="Valuation"
            title="One number per strike: NAV per unit."
            intro="The pool's net asset value is the market value of its positions and cash at the venue, minus accrued fees. Dividing by units outstanding gives NAV per unit, which every investor shares. Nobody is promised a rate; the strike moves with trading results, up or down."
          />
          <ul className="mt-8 space-y-3 text-[15px]">
            {[
              'Fees round down and are capped so NAV never goes negative.',
              'The performance fee is charged only above the previous high-water mark.',
              'Late subscribers do not share in results from before they joined.',
            ].map((t) => (
              <li key={t} className="flex gap-2.5">
                <Scale size={18} className="mt-0.5 shrink-0" style={{ color: 'var(--color-accent)' }} aria-hidden />
                <span className="opacity-80">{t}</span>
              </li>
            ))}
          </ul>
        </div>

        <figure className={`${card} overflow-hidden`}>
          <figcaption className="flex items-center justify-between border-b border-black/5 px-7 py-4 text-sm">
            <span className="font-semibold">Worked example</span>
            <span className="rounded-full bg-black/5 px-2.5 py-0.5 text-xs opacity-70">Illustrative, rounded</span>
          </figcaption>
          <table className="w-full text-sm">
            <tbody>
              {NAV_ROWS.map((r) => (
                <tr key={r.label} className="border-b border-black/5 last:border-0">
                  <th scope="row" className="px-7 py-3.5 text-left font-normal opacity-75">
                    {r.label}
                  </th>
                  <td className={`px-7 py-3.5 text-right tabular-nums ${r.emphasis ? 'font-semibold' : ''}`} style={r.emphasis ? { color: 'var(--color-accent)' } : undefined}>
                    {r.value}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="border-t border-black/5 bg-black/[0.02] px-7 py-4 text-sm leading-relaxed">
            An investor holding <strong>5,000 units</strong> before the strike gets 5,000 × (1.017950 − 1.000000) = <strong>+89.75 USDT</strong>. Had trading lost money,
            the same formula would produce a loss.
          </p>
        </figure>
      </div>
    </section>
  );
}

/* ---------------------------------------------------- withdrawal controls */

const REQUEST_CHECKS = ['Withdrawals not paused', 'Network active', 'Account active & KYC approved', 'Valid address, not a platform deposit address', 'Minimum amount and fee covered', 'Per-transaction, daily and global limits', 'Request velocity'];
const PAYOUT_CHECKS = ['Address screening result', 'New-address cooldown', 'Large-amount compliance review', 'Hot-wallet liquidity', 'Fresh, clean treasury reconciliation'];

export function WithdrawalControls() {
  return (
    <section id="controls" className="scroll-mt-8 py-20 text-[#f2f2ee] sm:py-28" style={{ background: 'var(--color-text)' }}>
      <div className={container}>
        <div className="max-w-2xl">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#b9a2f2]">Withdrawals</p>
          <h2 className="mt-3" style={{ ...headingStyle, fontSize: 'clamp(1.5rem, 3.5vw, 2.4rem)' }}>
            Two checkpoints. Unknown means hold, never approve.
          </h2>
          <p className="mt-4 text-[15px] leading-relaxed opacity-75 sm:text-base">
            Each decision is stored with the policy version that produced it, so any outcome can be explained after the fact. Policies are versioned and immutable.
          </p>
        </div>

        <div className="mt-12 grid gap-4 lg:grid-cols-[1fr_1fr_0.9fr]">
          <CheckList icon={ListChecks} title="At request" subtitle="Any failure rejects before funds are reserved" items={REQUEST_CHECKS} />
          <CheckList icon={FileClock} title="Before payout" subtitle="Approve, hold, send to manual review, or reject and release" items={PAYOUT_CHECKS} />
          <div className="rounded-3xl bg-white/[0.06] p-7 ring-1 ring-white/10">
            <PauseCircle size={22} className="text-[#b9a2f2]" aria-hidden />
            <h3 className="mt-4 text-lg font-semibold">Automatic pause</h3>
            <p className="mt-2 text-[15px] leading-relaxed opacity-75">
              If treasury reconciliation finds a discrepancy, or custody and chain disagree about a payout, withdrawals pause platform-wide. Resuming needs an admin other than the one who paused.
            </p>
            <p className="mt-4 text-[15px] leading-relaxed opacity-75">Reserved funds stay in your account while paused.</p>
          </div>
        </div>
      </div>
    </section>
  );
}

function CheckList({ icon: Icon, title, subtitle, items }: { icon: LucideIcon; title: string; subtitle: string; items: string[] }) {
  return (
    <div className="rounded-3xl bg-white/[0.06] p-7 ring-1 ring-white/10">
      <Icon size={22} className="text-[#b9a2f2]" aria-hidden />
      <h3 className="mt-4 text-lg font-semibold">{title}</h3>
      <p className="mt-1 text-sm opacity-60">{subtitle}</p>
      <ul className="mt-5 space-y-2.5 text-[15px]">
        {items.map((it) => (
          <li key={it} className="flex gap-2.5">
            <BadgeCheck size={16} className="mt-1 shrink-0 text-[#b9a2f2]" aria-hidden />
            <span className="opacity-85">{it}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* --------------------------------------------------------------- security */

const SECURITY: { icon: LucideIcon; title: string; body: string }[] = [
  { icon: KeyRound, title: 'Step-up authentication', body: 'Withdrawals and every staff action require a fresh second factor (AAL2 sessions).' },
  { icon: Undo2, title: 'Harmless retries', body: 'Jobs, API calls and custody requests are idempotent, so a retry never pays or credits twice.' },
  { icon: Landmark, title: 'Least-privilege database roles', body: 'Web and worker connect as separate roles with column-level grants; row-level security covers client access.' },
  { icon: Gauge, title: 'Hardened HTTP layer', body: 'CSRF protection, rate limits and strict security headers on every route; internal calls are HMAC-signed with nonces.' },
];

export function Security() {
  return (
    <section id="security" className={`${container} scroll-mt-8 py-20 sm:py-28`}>
      <SectionHeader eyebrow="Security" title="Authorization lives on the server." intro="The browser never decides what you are allowed to do. Every request is checked against your session and permissions, and every staff action leaves an audit record." />
      <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {SECURITY.map((s) => (
          <article key={s.title} className={`${card} p-7`}>
            <IconBadge icon={s.icon} />
            <h3 className="mt-5 font-semibold">{s.title}</h3>
            <p className="mt-2 text-sm leading-relaxed opacity-75">{s.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- networks */

const NETWORKS = [
  { name: 'Simulated EVM', kind: 'Development chain', confirmations: 3, status: 'Active' },
  { name: 'Ethereum Sepolia', kind: 'Public testnet', confirmations: 12, status: 'Configurable' },
  { name: 'BNB Smart Chain testnet', kind: 'Public testnet', confirmations: 15, status: 'Configurable' },
  { name: 'TRON Nile', kind: 'Public testnet', confirmations: 20, status: 'Planned' },
  { name: 'All mainnets', kind: 'Real-value networks', confirmations: null, status: 'Blocked in code' },
];

const COMPONENTS = [
  { name: 'Ledger, NAV and withdrawal policy', status: 'Implemented' },
  { name: 'Custody provider', status: 'Simulated' },
  { name: 'Trading venue', status: 'Simulated' },
  { name: 'Sanctions & wallet screening', status: 'Mocked' },
  { name: 'KYC verification', status: 'Manual review' },
];

function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'Active' || status === 'Implemented'
      ? { background: 'rgba(47,191,138,0.14)', color: '#17805a' }
      : status === 'Blocked in code'
        ? { background: 'rgba(240,106,106,0.14)', color: '#b23b3b' }
        : { background: 'rgba(115,66,226,0.1)', color: 'var(--color-accent)' };
  return (
    <span className="inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium" style={tone}>
      {status}
    </span>
  );
}

export function NetworksAndStatus() {
  return (
    <section id="networks" className="scroll-mt-8 bg-white/40 py-20 sm:py-28">
      <div className={container}>
        <SectionHeader
          eyebrow="Networks & status"
          title="What is live, what is simulated."
          intro="This build only runs on test networks. The database refuses to activate a mainnet, and both the web server and worker refuse to start if real funds are enabled."
        />
        <div className="mt-12 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
          <div className={`${card} overflow-x-auto`}>
            <table className="w-full min-w-[480px] text-sm">
              <caption className="sr-only">Supported networks</caption>
              <thead>
                <tr className="border-b border-black/5 text-left text-xs uppercase tracking-wider opacity-60">
                  <th scope="col" className="px-6 py-4 font-medium">Network</th>
                  <th scope="col" className="px-6 py-4 font-medium">Type</th>
                  <th scope="col" className="px-6 py-4 text-right font-medium">Confirmations</th>
                  <th scope="col" className="px-6 py-4 text-right font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {NETWORKS.map((n) => (
                  <tr key={n.name} className="border-b border-black/5 last:border-0">
                    <th scope="row" className="px-6 py-3.5 text-left font-medium">{n.name}</th>
                    <td className="px-6 py-3.5 opacity-70">{n.kind}</td>
                    <td className="px-6 py-3.5 text-right tabular-nums opacity-70">{n.confirmations ?? '—'}</td>
                    <td className="px-6 py-3.5 text-right"><StatusPill status={n.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className={`${card} p-7`}>
            <h3 className="font-semibold">Integrations in this build</h3>
            <ul className="mt-4 divide-y divide-black/5 text-sm">
              {COMPONENTS.map((c) => (
                <li key={c.name} className="flex items-center justify-between gap-4 py-3">
                  <span className="opacity-80">{c.name}</span>
                  <StatusPill status={c.status} />
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="mt-4 rounded-3xl p-7" style={{ background: 'rgba(115,66,226,0.08)' }}>
          <h3 className="text-lg font-semibold">What this build is not</h3>
          <ul className="mt-3 list-disc space-y-1.5 pl-5 text-[15px] opacity-75">
            <li>It does not accept, hold or pay out real funds. Mainnet networks are disabled in code.</li>
            <li>The trading venue is a simulator; its results are labelled “simulated” everywhere they appear.</li>
            <li>It has not been licensed, independently audited or penetration tested. See the production-readiness checklist in the repository.</li>
          </ul>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------- FAQ */

const FAQ: [string, string][] = [
  ['Is this real money?', 'No. This build runs on test networks and a simulated trading venue. Test tokens have no value, and mainnet networks are disabled in the code.'],
  ['Is there a guaranteed or fixed return?', 'No. There are no fixed rates and no scheduled balance increases. Your result depends entirely on how the pool’s trades perform, and it can be negative.'],
  ['How is my return calculated?', 'You own units of a pool. At each valuation, NAV per unit is struck from trade executions and market prices after fees. Your result is your units multiplied by the change in NAV per unit.'],
  ['What fees apply?', 'A management fee and a performance fee above a high-water mark are deducted inside the NAV, and a fixed fee applies per withdrawal. Fee rules are versioned and shown in the app.'],
  ['Why might my withdrawal be held?', 'New addresses have a cooldown, large amounts are reviewed, and payouts pause automatically if reconciliation finds a discrepancy. Reserved funds stay in your account.'],
];

export function Faq() {
  return (
    <section id="faq" className={`${container} scroll-mt-8 py-20 sm:py-28`}>
      <div className="grid gap-12 lg:grid-cols-[0.8fr_1.2fr]">
        <div>
          <SectionHeader eyebrow="FAQ" title="Common questions." />
          <Link href="/support" className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium transition hover:opacity-70" style={{ color: 'var(--color-accent)' }}>
            All support answers <ArrowRight size={16} aria-hidden />
          </Link>
        </div>
        <div className="space-y-3">
          {FAQ.map(([q, a]) => (
            <details key={q} className={`${card} group px-6 py-5`}>
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium [&::-webkit-details-marker]:hidden">
                {q}
                <span className="text-xl leading-none opacity-50 transition-transform group-open:rotate-45" aria-hidden>
                  +
                </span>
              </summary>
              <p className="mt-3 text-[15px] leading-relaxed opacity-75">{a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------- CTA */

export function FinalCta({ signedIn }: { signedIn: boolean }) {
  return (
    <section className={`${container} pb-20 sm:pb-28`}>
      <div className="relative overflow-hidden rounded-[32px] px-7 py-14 text-white sm:px-14 sm:py-20" style={{ background: 'linear-gradient(135deg, #7342e2 0%, #4b2aa8 100%)' }}>
        <div className="max-w-xl">
          <h2 style={{ ...headingStyle, fontSize: 'clamp(1.6rem, 4vw, 2.6rem)' }}>See the ledger for yourself.</h2>
          <p className="mt-4 text-[15px] leading-relaxed opacity-85 sm:text-base">
            Open a testnet account, deposit test USDT and follow each entry from deposit to withdrawal. Nothing here has real value.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href={signedIn ? '/dashboard' : '/register'} className="inline-flex items-center gap-3 rounded-full bg-white px-6 py-3.5 text-sm font-semibold transition hover:brightness-95" style={{ color: 'var(--color-accent)' }}>
              {signedIn ? 'Open your dashboard' : 'Create testnet account'}
              <ArrowRightCircle size={18} aria-hidden />
            </Link>
          </div>
        </div>
        <div className="pointer-events-none absolute -bottom-10 -right-10 opacity-15 sm:bottom-auto sm:right-14 sm:top-1/2 sm:-translate-y-1/2" aria-hidden>
          <div className="[--color-text:#ffffff]">
            <LogoMark size={220} />
          </div>
        </div>
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- footer */

const FOOTER_COLUMNS: { title: string; links: { label: string; href: string }[] }[] = [
  {
    title: 'Product',
    links: [
      { label: 'How it works', href: '#how-it-works' },
      { label: 'Valuation', href: '#nav' },
      { label: 'Withdrawals', href: '#controls' },
      { label: 'Networks', href: '#networks' },
    ],
  },
  {
    title: 'Account',
    links: [
      { label: 'Create account', href: '/register' },
      { label: 'Sign in', href: '/login' },
      { label: 'Dashboard', href: '/dashboard' },
    ],
  },
  {
    title: 'Help',
    links: [
      { label: 'Support & FAQ', href: '/support' },
    ],
  },
];

export function Footer() {
  return (
    <footer className="border-t border-black/10">
      <div className={`${container} grid gap-10 py-14 md:grid-cols-[1.4fr_repeat(3,1fr)]`}>
        <div className="max-w-sm">
          <div className="flex items-center gap-2.5">
            <LogoMark size={22} />
            <span className="font-semibold tracking-tight">EliteWhale</span>
          </div>
          <p className="mt-4 text-sm leading-relaxed opacity-65">An auditable USDT investment ledger, demonstrated on test networks with a simulated trading venue.</p>
        </div>
        {FOOTER_COLUMNS.map((col) => (
          <nav key={col.title} aria-label={col.title}>
            <h3 className="text-xs font-semibold uppercase tracking-[0.14em] opacity-50">{col.title}</h3>
            <ul className="mt-4 space-y-2.5 text-sm">
              {col.links.map((l) => (
                <li key={l.label}>
                  <Link href={l.href} className="opacity-75 transition hover:opacity-100">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className="border-t border-black/10">
        <div className={`${container} space-y-2 py-6 text-xs leading-relaxed opacity-60`}>
          <p>
            Testnet demonstration software. Not an offer, solicitation or recommendation to invest, and the operator is not licensed to provide investment services. No real funds are
            accepted, held or paid out.
          </p>
          <p>Returns are never guaranteed. Values can fall as well as rise, and simulated performance does not indicate future results.</p>
          <p>© {new Date().getFullYear()} EliteWhale</p>
        </div>
      </div>
    </footer>
  );
}
