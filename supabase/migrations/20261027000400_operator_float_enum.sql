-- =============================================================================
-- Manual balance adjustments backed by an operator float (part 1 of 2)
-- =============================================================================
-- New enum values cannot be used in the transaction that adds them.
alter type public.account_purpose add value if not exists 'operator_float';
