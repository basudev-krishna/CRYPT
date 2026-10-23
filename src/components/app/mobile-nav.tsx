'use client';
import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Menu, X } from 'lucide-react';
import { NavLink, type NavIcon } from './nav-link';

const EASE = [0.22, 1, 0.36, 1] as const;

/** Slide-in navigation drawer for small screens (same motion as the homepage menu). */
export function MobileNav({ nav, extra }: { nav: { href: string; label: string; icon: NavIcon }[]; extra?: { href: string; label: string } }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  return (
    <div className="lg:hidden">
      <button type="button" onClick={() => setOpen(true)} aria-label="Open menu" className="grid h-9 w-9 place-items-center rounded-full bg-white ring-1 ring-black/5 transition hover:ring-accent/40">
        <Menu size={18} />
      </button>
      <AnimatePresence>
        {open ? (
          <>
            <motion.div
              key="backdrop"
              className="fixed inset-0 z-40 bg-[rgba(25,40,55,0.35)] backdrop-blur-sm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setOpen(false)}
            />
            <motion.aside
              key="sheet"
              role="dialog"
              aria-modal="true"
              aria-label="Menu"
              className="fixed left-0 top-0 z-50 flex h-dvh w-[min(84vw,300px)] flex-col bg-white px-4 py-5 shadow-2xl"
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ ease: EASE, duration: 0.4 }}
            >
              <div className="mb-4 flex justify-end">
                <button type="button" onClick={() => setOpen(false)} aria-label="Close menu" className="rounded-full p-2 hover:bg-surface-3">
                  <X size={20} />
                </button>
              </div>
              <nav className="space-y-0.5 overflow-y-auto">
                {nav.map((n, i) => (
                  <motion.div key={n.href} initial={{ opacity: 0, x: -16 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.1 + i * 0.03, duration: 0.3, ease: EASE }}>
                    <NavLink href={n.href} icon={n.icon} onNavigate={() => setOpen(false)}>
                      {n.label}
                    </NavLink>
                  </motion.div>
                ))}
              </nav>
              {extra ? (
                <div className="mt-auto border-t border-line pt-3">
                  <NavLink href={extra.href} icon="console" onNavigate={() => setOpen(false)}>
                    {extra.label}
                  </NavLink>
                </div>
              ) : null}
            </motion.aside>
          </>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
