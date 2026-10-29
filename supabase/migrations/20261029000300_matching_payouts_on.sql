-- =============================================================================
-- Rewards program: switch matching payouts on
-- =============================================================================
-- The group decided (2026-10-29) to pay the matching bonus. Policies are
-- immutable, so this adds a new rewards_program version with only
-- matching.enabled turned on; every other setting is carried over from the
-- current version. If no version was ever saved, the published defaults
-- (DEFAULT_PROGRAM in src/server/referrals/program-math.ts) are used.
--
-- Nothing is paid automatically: the worker records each matching reward
-- (a share of operator-funded earnings only, never deposits), an administrator
-- approves it only if the reward fund covers it, and the worker posts it.
-- =============================================================================
with current_policy as (
  select params
    from public.policy_versions
   where kind = 'rewards_program' and effective_from <= now()
   order by effective_from desc, version desc
   limit 1
),
base as (
  select coalesce(
    (select params from current_policy),
    '{
      "program_start": "2026-10-28T00:00:00.000Z",
      "placement_mode": "outer",
      "matching": {
        "enabled": false,
        "tree": "sponsor",
        "levels": [
          {"level": 1, "rate_bps": 500}, {"level": 2, "rate_bps": 500}, {"level": 3, "rate_bps": 400},
          {"level": 4, "rate_bps": 400}, {"level": 5, "rate_bps": 400}, {"level": 6, "rate_bps": 300},
          {"level": 7, "rate_bps": 300}, {"level": 8, "rate_bps": 300}, {"level": 9, "rate_bps": 200},
          {"level": 10, "rate_bps": 100}
        ],
        "min_left": "50",
        "min_right": "50",
        "min_rank": null
      },
      "ranks": {
        "rewards_enabled": false,
        "token_id": null,
        "levels": [
          {"code": "E1", "left": "1500", "right": "1500", "self": "150", "bonus": "50"},
          {"code": "E2", "left": "9000", "right": "9000", "self": "500", "bonus": "300"},
          {"code": "E3", "left": "25000", "right": "25000", "self": "1000", "bonus": "1500"},
          {"code": "E4", "left": "55000", "right": "55000", "self": "2500", "bonus": "4500"},
          {"code": "E5", "left": "1000000", "right": "1000000", "self": "5000", "bonus": "9000"},
          {"code": "E6", "left": "2500000", "right": "2500000", "self": "10000", "bonus": "18000"},
          {"code": "E7", "left": "5000000", "right": "5000000", "self": "20000", "bonus": "29000"},
          {"code": "Prince", "left": "10000000", "right": "10000000", "self": "30000", "bonus": "50000"},
          {"code": "King", "left": "25000000", "right": "25000000", "self": "40000", "bonus": "1000000"},
          {"code": "Emperor", "left": "50000000", "right": "50000000", "self": "50000", "bonus": "3000000"}
        ]
      }
    }'::jsonb
  ) as params
)
insert into public.policy_versions (kind, version, params, change_note, created_by, approved_by)
select 'rewards_program',
       coalesce((select max(version) from public.policy_versions where kind = 'rewards_program'), 0) + 1,
       jsonb_set(base.params, '{matching,enabled}', 'true'::jsonb),
       'Matching payouts switched on by the group (2026-10-29)',
       'migration:20261029000300',
       'migration:20261029000300'
  from base
 where (base.params #>> '{matching,enabled}')::boolean is distinct from true;
