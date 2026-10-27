import { Badge } from './primitives';
import type { EntryKind } from '@/server/offchain/holdings';

const KINDS: Record<EntryKind, { label: string; tone: 'success' | 'info' | 'neutral' | 'warn' | 'danger' }> = {
  contribution: { label: 'Money received', tone: 'success' },
  earnings: { label: 'Earnings', tone: 'info' },
  payback: { label: 'Paid back', tone: 'neutral' },
  moved_to_platform: { label: 'Moved to platform', tone: 'neutral' },
  adjustment: { label: 'Adjustment', tone: 'warn' },
  reversal: { label: 'Correction', tone: 'danger' },
};

export function OffchainKind({ kind }: { kind: EntryKind }) {
  const k = KINDS[kind];
  return <Badge tone={k.tone}>{k.label}</Badge>;
}
