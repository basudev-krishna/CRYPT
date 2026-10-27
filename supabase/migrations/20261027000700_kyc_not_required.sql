-- =============================================================================
-- Private group: no identity verification required to deposit or withdraw.
--
-- Members are known personally and some settle with the administrator off the
-- platform, so the group does not run KYC. Policies are immutable, so this adds
-- a new version of the current deposit and withdrawal policy with only
-- require_kyc_approved turned off; every other parameter is carried over.
--
-- A database without policies yet (fresh local reset, before seed.sql) is left
-- unchanged; there the seeded policies still apply.
-- =============================================================================
insert into public.policy_versions (kind, version, params, change_note, created_by, approved_by)
select c.kind, c.version + 1, jsonb_set(c.params, '{require_kyc_approved}', 'false'::jsonb),
       'Private group: identity verification no longer required', 'migration:20261027000700', 'migration:20261027000700'
  from (
    select distinct on (kind) kind, version, params
      from public.policy_versions
     where kind in ('deposit', 'withdrawal') and effective_from <= now()
     order by kind, effective_from desc, version desc
  ) c
 where (c.params ->> 'require_kyc_approved')::boolean is distinct from false;
