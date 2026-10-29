import { Badge } from './primitives';
import type { EntryCategory, EntryKind, OffchainEntryView } from '@/server/offchain/holdings';

const KINDS: Record<EntryKind, { label: string; tone: 'success' | 'info' | 'neutral' | 'warn' | 'danger' }> = {
  contribution: { label: 'Money received', tone: 'success' },
  earnings: { label: 'Earnings', tone: 'info' },
  payback: { label: 'Paid back', tone: 'neutral' },
  moved_to_platform: { label: 'Moved to platform', tone: 'neutral' },
  adjustment: { label: 'Adjustment', tone: 'warn' },
  reversal: { label: 'Correction', tone: 'danger' },
};

export function OffchainKind({ kind, category }: { kind: EntryKind; category?: EntryCategory | null }) {
  const k = category === 'matching_bonus' ? { label: 'Matching bonus', tone: 'info' as const } : KINDS[kind];
  return <Badge tone={k.tone}>{k.label}</Badge>;
}

/** How an entry the administrator recorded reads in the member's activity. */
export function heldLabel(e: OffchainEntryView): string {
  if (e.category === 'matching_bonus') return 'Matching bonus';
  if (e.kind === 'contribution' || (e.kind === 'adjustment' && e.amountMicro > 0n)) return 'Deposit';
  if (e.kind === 'earnings') return 'Reward';
  if (e.kind === 'payback') return 'Paid out by the administrator';
  if (e.kind === 'moved_to_platform') return 'Moved to available balance';
  if (e.kind === 'reversal') return 'Correction';
  return 'Balance adjustment';
}
