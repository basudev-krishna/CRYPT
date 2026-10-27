-- =============================================================================
-- Operator-funded referral rewards (part 1 of 2)
-- =============================================================================
-- New enum values cannot be used in the transaction that adds them, so the
-- tables, functions and grants that use them live in the next migration.
alter type public.account_purpose add value if not exists 'referral_reward_fund';
alter type public.policy_kind add value if not exists 'referral';
