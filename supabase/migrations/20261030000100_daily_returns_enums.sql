-- =============================================================================
-- Fixed daily returns (part 1 of 2): ledger purposes
-- =============================================================================
-- New enum values cannot be used in the transaction that adds them.
alter type public.account_purpose add value if not exists 'plan_principal';  -- liability (member): capital committed to a plan
alter type public.account_purpose add value if not exists 'return_accrued';  -- liability (member): accrued daily returns, not yet due
alter type public.account_purpose add value if not exists 'return_payable';  -- liability (member): returns due, awaiting revenue funding
alter type public.account_purpose add value if not exists 'return_reserve';  -- liability (platform): business revenue set aside for returns
alter type public.account_purpose add value if not exists 'return_cost';     -- expense (platform): accrued returns not yet funded
