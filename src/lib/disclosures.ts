import { realFundsActive } from '@/server/phase-guard';

/**
 * Bump the version whenever the risk disclosure text changes; users must re-accept.
 * The real-funds (private group) disclosure is different text, so it has its own version.
 */
export const RISK_DISCLOSURE_VERSION = realFundsActive() ? '2026-10-24.live' : '2026-10-17.1';
