'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AnimatePresence, MotionConfig, motion, type Variants } from 'framer-motion';
import { ArrowRight, Menu, X } from 'lucide-react';

const EASE = [0.22, 1, 0.36, 1] as const;

/* Light, like the rest of the landing page; gold from the logo, deepened where it is text. */
const INK = '#192837';
const GOLD = '#d9b25f';
const GOLD_INK = '#9a6b1f';
const GOLD_TEXT = 'linear-gradient(180deg, #e6bb5c 0%, #c99a3c 42%, #a87526 78%, #7f5718 100%)';
const GOLD_FILL = 'linear-gradient(135deg, #f7e2a6 0%, #dcb35c 45%, #b8862f 100%)';
const HERO_BG =
  'radial-gradient(ellipse 60% 55% at 72% 42%, rgba(217,178,95,0.22) 0%, rgba(217,178,95,0) 70%), radial-gradient(ellipse 50% 40% at 10% 0%, rgba(115,66,226,0.08) 0%, rgba(115,66,226,0) 70%), linear-gradient(180deg, #fbfaf6 0%, #f6f4ee 55%, #f2f2ee 100%)';

const NAV_LINKS = [
  { label: 'About', href: '#about' },
  { label: 'Roadmap', href: '#roadmap' },
  { label: 'Projects', href: '#projects' },
  { label: 'Revenue', href: '#revenue' },
  { label: 'Support', href: '#support' },
];

const fadeUp: Variants = {
  hidden: { opacity: 0, y: 28 },
  visible: (i: number) => ({ opacity: 1, y: 0, transition: { delay: i * 0.15, duration: 0.7, ease: EASE } }),
};

/** The EliteWhale mark (public/logo.png, 3:2). `size` is its height; the width follows the image's aspect ratio. */
export function LogoMark({ size = 32 }: { size?: number }) {
  return <Image src="/logo.png" alt="" aria-hidden width={Math.round(size * 1.5)} height={size} className="shrink-0 object-contain" priority={size <= 40} />;
}

function Logo({ realFunds }: { realFunds: boolean }) {
  return (
    <Link href="/" className="flex items-center gap-2.5" aria-label="EliteWhale home">
      <LogoMark />
      <span className="text-base font-semibold tracking-tight">EliteWhale</span>
      {/* Testnet builds keep their label; the private group shows the brand alone. */}
      {realFunds ? null : (
        <span className="rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider" style={{ border: '1px solid rgba(154,107,31,0.35)', color: GOLD_INK }}>
          testnet
        </span>
      )}
    </Link>
  );
}

/** Primary/secondary CTAs; signed-in visitors get a single "Open app" link. */
function NavCtas({ signedIn, realFunds, onNavigate }: { signedIn: boolean; realFunds: boolean; onNavigate?: () => void }) {
  const base = 'rounded-full px-5 py-2.5 text-sm font-semibold text-center transition hover:brightness-110';
  const gold = { background: GOLD_FILL, color: '#1b1407', boxShadow: '0 6px 24px -8px rgba(217,178,95,0.6)' };
  if (signedIn) {
    return (
      <Link href="/dashboard" onClick={onNavigate} className={base} style={gold}>
        Open app
      </Link>
    );
  }
  return (
    <>
      <Link href="/register" onClick={onNavigate} className={base} style={gold}>
        {realFunds ? 'Request to Join' : 'Create Testnet Account'}
      </Link>
      <Link href="/login" onClick={onNavigate} className={`${base} hover:bg-black/5`} style={{ border: '1px solid rgba(25,40,55,0.2)', color: INK }}>
        Sign In
      </Link>
    </>
  );
}

function MobileSheet({ open, onClose, signedIn, realFunds }: { open: boolean; onClose: () => void; signedIn: boolean; realFunds: boolean }) {
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
            style={{ width: 'min(88vw, 360px)', height: '100dvh', background: '#fbfaf6', color: INK, borderLeft: '1px solid rgba(217,178,95,0.35)', boxShadow: '-12px 0 48px rgba(25,40,55,0.18)' }}
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ ease: EASE, duration: 0.45 }}
          >
            <div className="flex items-center justify-between">
              <Link href="/" onClick={onClose} aria-label="EliteWhale home">
                <LogoMark />
              </Link>
              <button type="button" onClick={onClose} aria-label="Close menu" className="rounded-full p-2 transition hover:bg-black/5">
                <X size={22} />
              </button>
            </div>
            <div className="my-5 h-px w-full" style={{ background: 'linear-gradient(90deg, rgba(217,178,95,0.5), rgba(217,178,95,0))' }} />
            <nav className="flex flex-col gap-1">
              {NAV_LINKS.map((l, i) => (
                <motion.div key={l.label} initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.18 + i * 0.07, duration: 0.4, ease: EASE }}>
                  <Link href={l.href} onClick={onClose} className="block py-3 text-lg font-medium transition hover:text-[#9a6b1f]">
                    {l.label}
                  </Link>
                </motion.div>
              ))}
            </nav>
            <div className="mt-auto flex flex-col gap-3">
              <NavCtas signedIn={signedIn} realFunds={realFunds} onNavigate={onClose} />
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

/** `realFunds` switches the testnet wording to the private group's (real BSC USDT). */
export function Hero({ signedIn, realFunds }: { signedIn: boolean; realFunds: boolean }) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <MotionConfig reducedMotion="user">
      <section className="relative w-full overflow-hidden lg:min-h-screen" style={{ fontFamily: 'var(--font-body)', color: INK, background: HERO_BG }}>
        {/* Fine gold grid, faded towards the edges. */}
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.12]"
          style={{
            backgroundImage: 'linear-gradient(rgba(217,178,95,1) 1px, transparent 1px), linear-gradient(90deg, rgba(217,178,95,1) 1px, transparent 1px)',
            backgroundSize: '64px 64px',
            maskImage: 'radial-gradient(ellipse 70% 60% at 50% 40%, #000 30%, transparent 75%)',
            WebkitMaskImage: 'radial-gradient(ellipse 70% 60% at 50% 40%, #000 30%, transparent 75%)',
          }}
          aria-hidden
        />

        <header className="relative z-10 mx-auto flex max-w-[1280px] items-center justify-between px-5 py-4 sm:px-8 sm:py-5">
          <Logo realFunds={realFunds} />
          <nav className="hidden items-center gap-8 md:flex">
            {NAV_LINKS.map((l) => (
              <Link key={l.label} href={l.href} className="text-sm font-medium opacity-75 transition hover:text-[#9a6b1f] hover:opacity-100">
                {l.label}
              </Link>
            ))}
          </nav>
          <div className="hidden items-center gap-2 md:flex">
            <NavCtas signedIn={signedIn} realFunds={realFunds} />
          </div>
          <button type="button" className="rounded-full p-2 md:hidden" onClick={() => setMenuOpen(true)} aria-label="Open menu" aria-expanded={menuOpen}>
            <Menu size={24} />
          </button>
        </header>

        <div
          className="relative z-10 mx-auto grid max-w-[1280px] items-center gap-6 px-5 pb-20 sm:px-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-12 lg:pb-28"
          style={{ paddingTop: 'clamp(16px, 5vw, 56px)' }}
        >
          {/* Logo on a lit stage: glow, two thin gold rings and a gentle float. */}
          <motion.div
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 1, ease: EASE }}
            className="relative order-first flex aspect-square w-full items-center justify-center justify-self-center lg:order-last"
            style={{ maxWidth: 560 }}
          >
            <div className="absolute inset-[12%] rounded-full blur-3xl" style={{ background: 'radial-gradient(circle, rgba(232,196,111,0.35) 0%, rgba(232,196,111,0) 70%)' }} aria-hidden />
            <div className="absolute inset-[4%] rounded-full" style={{ border: '1px solid rgba(185,134,47,0.35)' }} aria-hidden />
            <div className="absolute inset-[14%] rounded-full" style={{ border: '1px solid rgba(185,134,47,0.18)' }} aria-hidden />
            <motion.div
              className="absolute left-1/2 top-[4%] h-2 w-2 -translate-x-1/2 rounded-full"
              style={{ background: GOLD, boxShadow: '0 0 12px 3px rgba(232,196,111,0.8)' }}
              animate={{ opacity: [0.4, 1, 0.4] }}
              transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
              aria-hidden
            />
            <motion.div className="relative w-[88%]" animate={{ y: [0, -12, 0] }} transition={{ duration: 6, repeat: Infinity, ease: 'easeInOut' }}>
              <Image
                src="/logo.png"
                alt="EliteWhale logo"
                width={1536}
                height={1024}
                priority
                className="h-auto w-full object-contain"
                style={{ filter: 'drop-shadow(0 24px 40px rgba(25,40,55,0.22)) drop-shadow(0 0 32px rgba(232,196,111,0.25))' }}
              />
            </motion.div>
            {/* Reflection pool under the whale. */}
            <div className="absolute bottom-[10%] left-1/2 h-6 w-2/3 -translate-x-1/2 rounded-[50%] blur-xl" style={{ background: 'rgba(185,134,47,0.18)' }} aria-hidden />
          </motion.div>

          <div style={{ maxWidth: 600 }}>
            <motion.p
              custom={0}
              variants={fadeUp}
              initial="hidden"
              animate="visible"
              className="mb-6 inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-medium tracking-wide"
              style={{ border: '1px solid rgba(154,107,31,0.3)', background: 'rgba(217,178,95,0.12)', color: GOLD_INK }}
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: GOLD, boxShadow: '0 0 8px rgba(232,196,111,0.9)' }} aria-hidden />
              {realFunds ? 'USDT on BNB Smart Chain' : 'Testnet MVP · simulated trading venue'}
            </motion.p>

            <motion.h1
              custom={0}
              variants={fadeUp}
              initial="hidden"
              animate="visible"
              style={{ fontFamily: 'var(--font-heading)', lineHeight: 0.98, letterSpacing: '-0.02em' }}
            >
              <span className="block" style={{ fontSize: 'clamp(2rem, 5.2vw, 3.6rem)', color: INK }}>
                Welcome to
              </span>
              <span
                className="block pb-2"
                style={{ fontSize: 'clamp(3rem, 9vw, 6.2rem)', backgroundImage: GOLD_TEXT, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent', filter: 'drop-shadow(0 4px 18px rgba(185,134,47,0.18))' }}
              >
                EliteWhale
              </span>
            </motion.h1>

            <motion.div custom={1} variants={fadeUp} initial="hidden" animate="visible" className="mb-7 mt-3 flex items-center gap-4">
              <span className="h-px w-8 shrink-0 sm:w-12" style={{ background: `linear-gradient(90deg, rgba(217,178,95,0), ${GOLD})` }} aria-hidden />
              <span className="whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.22em] sm:text-[11px] sm:tracking-[0.34em]" style={{ color: GOLD_INK }}>
                The next generation era
              </span>
              <span className="h-px w-8 shrink-0 sm:w-12" style={{ background: `linear-gradient(90deg, ${GOLD}, rgba(217,178,95,0))` }} aria-hidden />
            </motion.div>

            <motion.p custom={1} variants={fadeUp} initial="hidden" animate="visible" style={{ fontSize: 'clamp(0.98rem, 2.4vw, 1.12rem)', lineHeight: 1.7, opacity: 0.8, maxWidth: 540 }}>
              A Web3 ecosystem built for real utility, transparent trading and sustainable digital-asset participation, growing together with its community.
            </motion.p>

            <motion.div custom={2} variants={fadeUp} initial="hidden" animate="visible" className="mt-9 flex flex-wrap items-center gap-3">
              <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
                <Link
                  href={signedIn ? '/dashboard' : '/register'}
                  className="flex items-center gap-6 rounded-full px-7 py-4 text-[15px] font-semibold transition hover:brightness-110"
                  style={{ background: GOLD_FILL, color: '#1b1407', boxShadow: '0 10px 36px -10px rgba(217,178,95,0.75), inset 0 1px 0 rgba(255,255,255,0.45)' }}
                >
                  {signedIn ? 'Open Your Dashboard' : realFunds ? 'Request to Join' : 'Try It on Testnet'}
                  <ArrowRight size={18} aria-hidden />
                </Link>
              </motion.div>
              <Link href="#about" className="rounded-full px-6 py-4 text-[15px] font-medium transition hover:bg-black/5" style={{ border: '1px solid rgba(25,40,55,0.2)' }}>
                Discover EliteWhale
              </Link>
            </motion.div>

            <motion.p custom={3} variants={fadeUp} initial="hidden" animate="visible" className="mt-7 text-xs" style={{ opacity: 0.6, maxWidth: 480 }}>
              Returns are never guaranteed. Investment values can fall as well as rise, and you can lose some or all of the amount invested.
            </motion.p>
          </div>
        </div>

        <div className="absolute inset-x-0 bottom-0 h-px" style={{ background: 'linear-gradient(90deg, rgba(217,178,95,0), rgba(217,178,95,0.6), rgba(217,178,95,0))' }} aria-hidden />

        <MobileSheet open={menuOpen} onClose={() => setMenuOpen(false)} signedIn={signedIn} realFunds={realFunds} />
      </section>
    </MotionConfig>
  );
}
