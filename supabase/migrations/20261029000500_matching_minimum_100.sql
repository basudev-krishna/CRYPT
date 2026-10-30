-- =============================================================================
-- Rewards program: minimum matching amount 100 USD per side
-- =============================================================================
-- The group decided (2026-10-29) that a member needs at least 100 USD of
-- operator-funded earnings in each of their left and right teams before the
-- matching bonus can pay them (was 50). Adds a new rewards_program version on
-- top of the current one (matching switched on by 20261029000300); every other
-- setting is carried over. Matching stays on.
-- =============================================================================
with current_policy as (
  select params
    from public.policy_versions
   where kind = 'rewards_program' and effective_from <= now()
   order by effective_from desc, version desc
   limit 1
)
insert into public.policy_versions (kind, version, params, change_note, created_by, approved_by)
select 'rewards_program',
       (select max(version) from public.policy_versions where kind = 'rewards_program') + 1,
       jsonb_set(jsonb_set(jsonb_set(c.params, '{matching,min_left}', '"100"'::jsonb), '{matching,min_right}', '"100"'::jsonb), '{matching,enabled}', 'true'::jsonb),
       'Minimum matching amount set to 100 USD per side, matching on (group decision 2026-10-29)',
       'migration:20261029000500',
       'migration:20261029000500'
  from current_policy c
 where not (c.params #>> '{matching,min_left}' = '100' and c.params #>> '{matching,min_right}' = '100' and (c.params #>> '{matching,enabled}')::boolean is true);
