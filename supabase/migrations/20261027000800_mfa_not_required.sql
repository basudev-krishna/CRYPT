-- =============================================================================
-- Private group: members no longer need two-factor authentication to withdraw.
--
-- Adds a new version of the current withdrawal policy with only require_mfa
-- turned off; every other parameter is carried over. Staff sessions still need
-- two-factor (AAL2), which is enforced in the application, not by this policy.
-- A database without a withdrawal policy yet is left unchanged.
-- =============================================================================
insert into public.policy_versions (kind, version, params, change_note, created_by, approved_by)
select c.kind, c.version + 1, jsonb_set(c.params, '{require_mfa}', 'false'::jsonb),
       'Private group: two-factor no longer required for member withdrawals', 'migration:20261027000800', 'migration:20261027000800'
  from (
    select distinct on (kind) kind, version, params
      from public.policy_versions
     where kind = 'withdrawal' and effective_from <= now()
     order by kind, effective_from desc, version desc
  ) c
 where (c.params ->> 'require_mfa')::boolean is distinct from false;
