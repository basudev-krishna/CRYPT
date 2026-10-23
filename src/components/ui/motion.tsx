'use client';
import { MotionConfig, motion, type Variants } from 'framer-motion';
import type { ReactNode } from 'react';

const EASE = [0.22, 1, 0.36, 1] as const;

const item: Variants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE } },
};

/** Fades and lifts its children into view once, the same motion the homepage sections use. */
export function Reveal({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  return (
    <motion.div className={className} initial="hidden" whileInView="visible" viewport={{ once: true, margin: '-40px' }} variants={item} transition={{ delay }}>
      {children}
    </motion.div>
  );
}

/** A grid whose direct children reveal one after another. Wrap each child in <StaggerItem>. */
export function Stagger({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div className={className} initial="hidden" whileInView="visible" viewport={{ once: true, margin: '-40px' }} variants={{ visible: { transition: { staggerChildren: 0.07 } } }}>
      {children}
    </motion.div>
  );
}

export function StaggerItem({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div className={className} variants={item}>
      {children}
    </motion.div>
  );
}

/** Soft entrance for each page; mounted from route templates so it replays on navigation. */
export function PageTransition({ children }: { children: ReactNode }) {
  return (
    <MotionConfig reducedMotion="user">
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: EASE }}>
        {children}
      </motion.div>
    </MotionConfig>
  );
}
