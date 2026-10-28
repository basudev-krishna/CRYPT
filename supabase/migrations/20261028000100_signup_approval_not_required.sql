-- =============================================================================
-- Private group: new sign-ups no longer need administrator approval.
--
-- Every account created through Supabase Auth now starts 'active' and can use
-- the app as soon as it signs in (after email verification, if that is on).
-- Accounts still waiting in the approval queue are activated now. Rejected
-- accounts stay rejected; an administrator can still approve them from the
-- approvals page. The pending_approval status, reviewed_at/reviewed_by and the
-- approval code are kept so history stays readable and the gate can be switched
-- back on by a later migration.
-- =============================================================================

create or replace function private.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_meta     jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_inv      record;
  v_sponsor  uuid;
  v_referral text := upper(nullif(btrim(v_meta ->> 'referral_code'), ''));
begin
  select id, sponsor_user_id into v_inv from public.member_invitations where accepted_user_id = new.id;
  v_sponsor := v_inv.sponsor_user_id;
  if v_sponsor is null and v_referral is not null then
    select user_id into v_sponsor from public.user_profiles where member_code = v_referral and account_status = 'active';
  end if;
  insert into public.user_profiles (user_id, email, sponsor_user_id, invitation_id, account_status, username, display_name, phone, country_code)
  values (new.id, coalesce(new.email, ''), v_sponsor, v_inv.id, 'active',
          lower(nullif(btrim(v_meta ->> 'username'), '')),
          left(nullif(btrim(v_meta ->> 'full_name'), ''), 60),
          nullif(btrim(v_meta ->> 'phone'), ''),
          upper(nullif(btrim(v_meta ->> 'country_code'), '')))
  on conflict (user_id) do nothing;
  return new;
end $$;

update public.user_profiles
   set account_status = 'active'
 where account_status = 'pending_approval';
