import { Badge, type Tone } from './primitives';

const DEPOSIT: Record<string, [string, Tone]> = {
  awaiting_deposit: ['Awaiting deposit', 'neutral'],
  detected: ['Detected', 'info'],
  confirming: ['Confirming', 'info'],
  confirmed: ['Confirmed', 'info'],
  credited: ['Credited', 'success'],
  under_review: ['Under review', 'warn'],
  failed: ['Failed', 'danger'],
  recovery_required: ['Recovery required', 'danger'],
};

const WITHDRAWAL: Record<string, [string, Tone]> = {
  requested: ['Requested', 'neutral'],
  pending_verification: ['Awaiting confirmation', 'warn'],
  reserved: ['Reserved', 'info'],
  processing: ['Processing', 'info'],
  broadcast: ['Broadcast', 'info'],
  confirmed: ['Confirmed', 'success'],
  rejected: ['Rejected', 'danger'],
  failed: ['Failed', 'danger'],
  cancelled: ['Cancelled', 'neutral'],
};

const KYC: Record<string, [string, Tone]> = {
  not_started: ['Not started', 'neutral'],
  pending: ['Pending review', 'warn'],
  approved: ['Verified', 'success'],
  rejected: ['Rejected', 'danger'],
  expired: ['Expired', 'warn'],
};

const ORDER: Record<string, [string, Tone]> = {
  pending: ['Pending next NAV', 'warn'],
  executed: ['Executed', 'success'],
  cancelled: ['Cancelled', 'neutral'],
};

const make = (map: Record<string, [string, Tone]>) =>
  function StatusBadge({ status }: { status: string }) {
    const [label, tone] = map[status] ?? [status, 'neutral'];
    return <Badge tone={tone}>{label}</Badge>;
  };

export const DepositStatus = make(DEPOSIT);
export const WithdrawalStatus = make(WITHDRAWAL);
export const KycStatus = make(KYC);
export const OrderStatus = make(ORDER);

export const EVENT_LABELS: Record<string, string> = {
  deposit_received: 'Deposit received',
  deposit_credit: 'Deposit credited',
  deposit_allocated: 'Credited by administrator',
  subscription_requested: 'Investment requested',
  subscription_executed: 'Investment executed',
  subscription_cancelled: 'Investment cancelled',
  subscription_refunded: 'Investment refunded',
  redemption_executed: 'Redemption executed',
  withdrawal_reserved: 'Withdrawal reserved',
  withdrawal_settled: 'Withdrawal sent',
  withdrawal_released: 'Withdrawal released',
  referral_reward: 'Referral reward',
  manual_adjustment: 'Adjusted by administrator',
  referral_bonus: 'Referral bonus',
  reversal: 'Correction (reversal)',
};
