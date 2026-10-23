-- =============================================================================
-- Admin-approved sign-up: account states (part 1 of 2)
-- =============================================================================
-- New enum values cannot be used in the transaction that adds them, so the
-- functions and grants that use them live in the next migration.
alter type public.account_status add value if not exists 'pending_approval';
alter type public.account_status add value if not exists 'rejected';
