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

type RewardStatus = 'pending' | 'approved' | 'rejected' | 'posted' | 'cancelled' | 'earned' | 'no_deposit' | 'not_eligible' | 'program_off';

const REWARDS: Record<RewardStatus, { label: string; tone: 'success' | 'warn' | 'info' | 'danger' | 'neutral'; title: string }> = {
  earned: { label: 'Earned · awaiting approval', tone: 'warn', title: 'Earned by their first deposit; an administrator approves it before it is paid' },
  no_deposit: { label: 'No deposit yet', tone: 'neutral', title: 'Earned when their first deposit is credited' },
  not_eligible: { label: 'Not eligible', tone: 'neutral', title: 'Joined before the program started, or an account is not active' },
  program_off: { label: 'Program off', tone: 'neutral', title: 'Referral commissions are not switched on' },
  pending: { label: 'Pending review', tone: 'warn', title: 'Waiting for an administrator; not withdrawable' },
  approved: { label: 'Approved', tone: 'info', title: 'Approved, paid shortly from the referral fund; not withdrawable yet' },
  posted: { label: 'Paid', tone: 'success', title: 'Credited to available balance' },
  rejected: { label: 'Rejected', tone: 'danger', title: 'Not paid' },
  cancelled: { label: 'Cancelled', tone: 'danger', title: 'Not paid: the matched earning was reversed' },
};

/**
 * `claimed` (member view): open rewards read as "Ready to claim" until the
 * member claims them, then "Claimed · …" until paid.
 */
export function ReferralRewardStatus({ status, claimed }: { status: RewardStatus; claimed?: boolean }) {
  if (claimed !== undefined && (status === 'pending' || status === 'approved')) {
    const label = claimed ? (status === 'pending' ? 'Claimed · awaiting approval' : 'Claimed · being paid') : status === 'pending' ? 'Ready to claim' : 'Approved · claim to receive';
    return <Badge tone={claimed ? 'info' : 'warn'} title={claimed ? 'Paid once approved and the reward fund covers it' : 'Claim it to have it paid to your available balance'}>{label}</Badge>;
  }
  const s = REWARDS[status];
  return <Badge tone={s.tone} title={s.title}>{s.label}</Badge>;
}
