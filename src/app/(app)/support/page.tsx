import type { Metadata } from 'next';
import { Mail, Mountain, Target } from 'lucide-react';
import { pageUser } from '@/server/http/auth';
import { Card, CardHeader, PageHeader } from '@/components/ui/primitives';
import { ELITEWHALE_ABOUT, ELITEWHALE_MISSION, ELITEWHALE_VISION, SOCIAL_LINKS, SUPPORT_EMAIL } from '@/components/support-contact';

export const metadata: Metadata = { title: 'Support' };

/** Wallets named in the EliteWhale presentation; any wallet that can send USDT (BEP20) and sign a message works. */
const WALLETS = ['Trust Wallet', 'MetaMask', 'TokenPocket', 'SafePal'];

export default async function SupportPage() {
  await pageUser();
  return (
    <>
      <PageHeader title="Support" description="Questions about your account, deposits, withdrawals or rewards? We are here to help." />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Email us" subtitle="Include your member id or username so we can find your account quickly." />
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="inline-flex max-w-full items-center gap-3 break-all rounded-full bg-accent px-5 py-3 text-sm font-semibold text-white transition hover:brightness-105"
          >
            <Mail size={18} className="shrink-0" aria-hidden />
            {SUPPORT_EMAIL}
          </a>
          <p className="mt-4 text-xs text-fg-muted">
            EliteWhale staff will never ask for your password, two-factor code, seed phrase or private key. Do not share them with anyone.
          </p>
        </Card>

        <Card>
          <CardHeader title="Community" subtitle="Follow EliteWhale and join the conversation." />
          <ul className="grid gap-2 sm:grid-cols-2">
            {SOCIAL_LINKS.map((s) => (
              <li key={s.label}>
                <a
                  href={s.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 rounded-xl bg-surface-3/60 px-4 py-3 text-sm font-medium ring-1 ring-black/5 transition hover:bg-surface-3"
                >
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">
                    <s.icon size={16} />
                  </span>
                  {s.label}
                </a>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader title="About EliteWhale" subtitle="The next generation era" />
          <div className="space-y-3 text-sm leading-relaxed text-fg-muted">
            {ELITEWHALE_ABOUT.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </div>
          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <div className="rounded-xl bg-surface-3/60 p-4 ring-1 ring-black/5">
              <p className="flex items-center gap-2 text-sm font-semibold">
                <Target size={16} className="text-accent" aria-hidden /> Vision
              </p>
              <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">{ELITEWHALE_VISION}</p>
            </div>
            <div className="rounded-xl bg-surface-3/60 p-4 ring-1 ring-black/5">
              <p className="flex items-center gap-2 text-sm font-semibold">
                <Mountain size={16} className="text-accent" aria-hidden /> Mission
              </p>
              <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">{ELITEWHALE_MISSION}</p>
            </div>
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader title="Supported wallets" subtitle="Use your preferred wallet on BNB Smart Chain." />
          <ul className="flex flex-wrap gap-2">
            {WALLETS.map((w) => (
              <li key={w} className="rounded-full bg-accent/10 px-3 py-1 text-sm font-medium text-accent">
                {w}
              </li>
            ))}
            <li className="rounded-full bg-surface-3 px-3 py-1 text-sm text-fg-muted">and many more</li>
          </ul>
          <p className="mt-3 text-xs text-fg-muted">Deposits and withdrawals are in USDT (BEP20). Your wallet must be able to sign a message so we can link it to your account.</p>
        </Card>
      </div>
    </>
  );
}
