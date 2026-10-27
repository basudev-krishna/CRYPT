import { Badge } from './primitives';
import type { ReferralStage } from '@/server/queries/user';

const STAGES: Record<ReferralStage, { label: string; tone: 'success' | 'warn' | 'neutral' | 'danger'; title: string }> = {
  awaiting_approval: { label: 'Awaiting approval', tone: 'warn', title: 'An administrator has not approved this account yet' },
  joined: { label: 'Joined', tone: 'neutral', title: 'Approved, no credited deposit yet' },
  qualified: { label: 'Qualified', tone: 'success', title: 'Approved and has a credited deposit' },
  inactive: { label: 'Inactive', tone: 'danger', title: 'Rejected, restricted, frozen or closed' },
};

export function ReferralStageBadge({ stage }: { stage: ReferralStage }) {
  const s = STAGES[stage];
  return <Badge tone={s.tone} title={s.title}>{s.label}</Badge>;
}

type RewardStatus = 'pending' | 'approved' | 'rejected' | 'posted';

const REWARDS: Record<RewardStatus, { label: string; tone: 'success' | 'warn' | 'info' | 'danger'; title: string }> = {
  pending: { label: 'Pending review', tone: 'warn', title: 'Waiting for an administrator; not withdrawable' },
  approved: { label: 'Approved', tone: 'info', title: 'Approved, paid shortly from the referral fund; not withdrawable yet' },
  posted: { label: 'Paid', tone: 'success', title: 'Credited to available balance' },
  rejected: { label: 'Rejected', tone: 'danger', title: 'Not paid' },
};

export function ReferralRewardStatus({ status }: { status: RewardStatus }) {
  const s = REWARDS[status];
  return <Badge tone={s.tone} title={s.title}>{s.label}</Badge>;
}
