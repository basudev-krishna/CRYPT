-- =============================================================================
-- Referral program: switch on, 5% of the referred member's first deposit
-- =============================================================================
-- The group decided (2026-10-29) to pay a referral commission of 5%. Policies
-- are immutable, so this adds a new 'referral' version with enabled = true and
-- reward_bps = 500; the start date, tiers and fixed amount are carried over from
-- the current version, or set to the defaults if none was ever saved.
--
-- Still one reward per referred member (unique in referral_rewards), recorded
-- by the worker when their first deposit is credited, paid only from the
-- operator's referral_reward_fund and only after an administrator approves it.
-- =============================================================================
with current_policy as (
  select params
    from public.policy_versions
   where kind = 'referral' and effective_from <= now()
   order by effective_from desc, version desc
   limit 1
),
base as (
  select coalesce(
    (select params from current_policy),
    '{
      "enabled": false,
      "reward_amount": "0",
      "program_start": "2026-10-29T00:00:00.000Z",
      "tiers": [
        {"label": "EW1", "min_qualified": 1}, {"label": "EW2", "min_qualified": 3}, {"label": "EW3", "min_qualified": 5},
        {"label": "EW4", "min_qualified": 10}, {"label": "EW5", "min_qualified": 25}, {"label": "EW6", "min_qualified": 50},
        {"label": "EW7", "min_qualified": 100}
      ]
    }'::jsonb
  ) as params
)
insert into public.policy_versions (kind, version, params, change_note, created_by, approved_by)
select 'referral',
       coalesce((select max(version) from public.policy_versions where kind = 'referral'), 0) + 1,
       base.params || '{"enabled": true, "reward_bps": 500}'::jsonb,
       'Referral commission switched on: 5% of the referred member''s first deposit (group decision 2026-10-29)',
       'migration:20261029000400',
       'migration:20261029000400'
  from base
 where not ((base.params ->> 'enabled')::boolean is true and (base.params ->> 'reward_bps') = '500');
