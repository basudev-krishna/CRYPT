-- =============================================================================
-- Off-platform entries: an optional category for earnings
-- =============================================================================
-- An administrator can add a matching bonus to a member's record (money held
-- with the administrator, not withdrawable). It is an ordinary 'earnings'
-- entry tagged 'matching_bonus', so the member's Matching bonus tab can list
-- it apart from other rewards. Entries stay immutable; the category is set
-- once, at insert.

alter table public.offchain_entries
  add column category text,
  add constraint offchain_entries_category check (category is null or (category = 'matching_bonus' and kind = 'earnings'));

grant insert (category) on public.offchain_entries to app_web;
