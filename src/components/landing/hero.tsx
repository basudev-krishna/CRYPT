'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AnimatePresence, MotionConfig, motion, type Variants } from 'framer-motion';
import { ArrowRightCircle, Fingerprint, LockKeyhole, Menu, Waves, X } from 'lucide-react';

const VIDEO_SRC = 'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260518_003132_8b7edcb6-c64d-4a52-a9ca-879942e122ad.mp4';
const EASE = [0.22, 1, 0.36, 1] as const;

const NAV_LINKS = [
  { label: 'How it works', href: '#how-it-works' },
  { label: 'Valuation', href: '#nav' },
  { label: 'Withdrawals', href: '#controls' },
  { label: 'Security', href: '#security' },
  { label: 'FAQ', href: '#faq' },
];

const fadeUp: Variants = {
  hidden: { opacity: 0, y: 28 },
  visible: (i: number) => ({ opacity: 1, y: 0, transition: { delay: i * 0.15, duration: 0.6, ease: EASE } }),
};

/** The EliteWhale mark (public/logo.png, 3:2). `size` is its height; the width follows the image's aspect ratio. */
export function LogoMark({ size = 32 }: { size?: number }) {
  return <Image src="/logo.png" alt="" aria-hidden width={Math.round(size * 1.5)} height={size} className="shrink-0 object-contain" priority={size <= 40} />;
}

function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2.5" aria-label="EliteWhale home">
      <LogoMark />
      <span className="text-base font-semibold tracking-tight">EliteWhale</span>
      <span className="rounded-full border border-[color:var(--color-text)]/25 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider opacity-70">testnet</span>
    </Link>
  );
}

/** Primary/secondary CTAs; signed-in visitors get a single "Open app" link. */
function NavCtas({ signedIn, onNavigate }: { signedIn: boolean; onNavigate?: () => void }) {
  const base = 'rounded-full px-5 py-2.5 text-sm font-medium text-center transition hover:brightness-105';
  if (signedIn) {
    return (
      <Link href="/dashboard" onClick={onNavigate} className={`${base} text-white`} style={{ background: 'var(--color-accent)' }}>
        Open app
      </Link>
    );
  }
  return (
    <>
      <Link href="/register" onClick={onNavigate} className={`${base} text-white`} style={{ background: 'var(--color-accent)' }}>
        Create Testnet Account
      </Link>
      <Link href="/login" onClick={onNavigate} className={base} style={{ background: 'var(--color-login-bg)' }}>
        Sign In
      </Link>
    </>
  );
}

function MobileSheet({ open, onClose, signedIn }: { open: boolean; onClose: () => void; signedIn: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="backdrop"
            className="fixed inset-0 z-40"
            style={{ background: 'rgba(25,40,55,0.35)', backdropFilter: 'blur(4px)' }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.aside
            key="sheet"
            role="dialog"
            aria-modal="true"
            aria-label="Menu"
            className="fixed right-0 top-0 z-50 flex flex-col px-6 py-5"
            style={{ width: 'min(88vw, 360px)', height: '100dvh', background: '#CFC8C5', boxShadow: '-12px 0 48px rgba(25,40,55,0.18)' }}
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ ease: EASE, duration: 0.45 }}
          >
            <div className="flex items-center justify-between">
              <LogoMark />
              <button type="button" onClick={onClose} aria-label="Close menu" className="rounded-full p-2 transition hover:bg-black/5">
                <X size={22} />
              </button>
            </div>
            <div className="my-5 h-px w-full" style={{ background: 'rgba(25,40,55,0.15)' }} />
            <nav className="flex flex-col gap-1">
              {NAV_LINKS.map((l, i) => (
                <motion.div key={l.label} initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.18 + i * 0.07, duration: 0.4, ease: EASE }}>
                  <Link href={l.href} onClick={onClose} className="block py-3 text-lg font-medium transition hover:opacity-70">
                    {l.label}
                  </Link>
                </motion.div>
              ))}
            </nav>
            <div className="mt-auto flex flex-col gap-3">
              <NavCtas signedIn={signedIn} onNavigate={onClose} />
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

const iconStyle = { display: 'inline-block', verticalAlign: 'middle', position: 'relative', top: -2 } as const;

export function Hero({ signedIn }: { signedIn: boolean }) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <MotionConfig reducedMotion="user">
      <section className="relative min-h-screen w-full overflow-hidden" style={{ fontFamily: 'var(--font-body)', color: 'var(--color-text)' }}>
        {/* Gradient shows while the video loads, and stays if it fails. */}
        <div className="absolute inset-0" style={{ background: 'linear-gradient(160deg, #f2f2ee 0%, #e4dcf7 55%, #cfc8c5 100%)' }} aria-hidden />
        <video className="absolute inset-0 h-full w-full object-cover" src={VIDEO_SRC} autoPlay muted loop playsInline preload="metadata" aria-hidden />

        <header className="relative z-10 mx-auto flex max-w-[1280px] items-center justify-between px-5 py-4 sm:px-8 sm:py-5">
          <Logo />
          <nav className="hidden items-center gap-8 md:flex">
            {NAV_LINKS.map((l) => (
              <Link key={l.label} href={l.href} className="text-sm font-medium transition-opacity hover:opacity-60">
                {l.label}
              </Link>
            ))}
          </nav>
          <div className="hidden items-center gap-2 md:flex">
            <NavCtas signedIn={signedIn} />
          </div>
          <button type="button" className="rounded-full p-2 md:hidden" onClick={() => setMenuOpen(true)} aria-label="Open menu" aria-expanded={menuOpen}>
            <Menu size={24} />
          </button>
        </header>

        <div className="relative z-10 mx-auto max-w-[1280px] px-5 sm:px-8" style={{ paddingTop: 'clamp(40px, 8vw, 72px)' }}>
          <div style={{ maxWidth: 560 }}>
            <motion.p
              custom={0}
              variants={fadeUp}
              initial="hidden"
              animate="visible"
              className="mb-5 inline-flex rounded-full px-3 py-1 text-xs font-medium"
              style={{ background: 'rgba(115,66,226,0.12)', color: 'var(--color-accent)' }}
            >
              Testnet MVP · simulated trading venue
            </motion.p>

            <motion.h1
              custom={0}
              variants={fadeUp}
              initial="hidden"
              animate="visible"
              style={{ fontFamily: 'var(--font-heading)', fontSize: 'clamp(1.65rem, 5vw, 3rem)', lineHeight: 1.05, letterSpacing: '-0.01em', marginBottom: 24 }}
            >
              <Waves size={24} style={iconStyle} aria-hidden /> Follow Every USDT <LockKeyhole size={24} style={iconStyle} aria-hidden /> Through an Auditable
              Investment Ledger <Fingerprint size={24} style={iconStyle} aria-hidden />
            </motion.h1>

            <motion.p
              custom={1}
              variants={fadeUp}
              initial="hidden"
              animate="visible"
              style={{ fontSize: 'clamp(0.9rem, 2.5vw, 1.1rem)', lineHeight: 1.65, opacity: 0.8, maxWidth: 560 }}
            >
              Clear books, full visibility. Every balance comes from an immutable double-entry ledger, performance is valued from real trade executions, and withdrawals follow
              published rules.
            </motion.p>

            <motion.div custom={2} variants={fadeUp} initial="hidden" animate="visible" className="mt-8">
              <motion.div className="inline-block" whileHover={{ scale: 1.04, filter: 'brightness(1.1)' }} whileTap={{ scale: 0.96 }}>
                <Link
                  href={signedIn ? '/dashboard' : '/register'}
                  className="flex items-center justify-between font-semibold text-white"
                  style={{
                    background: 'var(--color-accent)',
                    borderRadius: 50,
                    padding: '17px 24px',
                    fontSize: 'clamp(0.9rem, 2vw, 1rem)',
                    boxShadow: '0 4px 24px rgba(115,66,226,0.28)',
                    minWidth: 210,
                    gap: 32,
                  }}
                >
                  {signedIn ? 'Open Your Dashboard' : 'Try It on Testnet'}
                  <ArrowRightCircle size={20} aria-hidden />
                </Link>
              </motion.div>
            </motion.div>

            <motion.p custom={3} variants={fadeUp} initial="hidden" animate="visible" className="mt-6 text-xs" style={{ opacity: 0.7, maxWidth: 480 }}>
              Returns are never guaranteed. Investment values can fall as well as rise, and you can lose some or all of the amount invested.
            </motion.p>
          </div>
        </div>

        <MobileSheet open={menuOpen} onClose={() => setMenuOpen(false)} signedIn={signedIn} />
      </section>
    </MotionConfig>
  );
}
