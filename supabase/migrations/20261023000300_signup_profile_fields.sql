-- =============================================================================
-- Sign-up profile fields: username, phone, full name, country, referral
-- =============================================================================
-- The register form collects these and the server route validates them first;
-- the auth trigger copies them from sign-up metadata into the profile once, at
-- insert. Metadata is client-editable afterwards, so it is never read again.
--
-- Usernames are a sign-in alias for the email address, stored lower-case and
-- unique. The web role has no UPDATE grant on username or phone, so they are
-- fixed after sign-up. A referral id records who referred the member (the same
-- permanent sponsor link invitations used); it carries no payouts.

alter table public.user_profiles
  add column username text,
  add column phone    text,
  add constraint user_profiles_username_format check (username is null or username ~ '^[a-z0-9_]{4,20}$'),
  add constraint user_profiles_phone_format check (phone is null or phone ~ '^\+[1-9][0-9]{6,14}$');
create unique index user_profiles_username_uq on public.user_profiles (username);

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
  values (new.id, coalesce(new.email, ''), v_sponsor, v_inv.id,
          case when session_user = 'supabase_auth_admin' then 'pending_approval' else 'active' end::public.account_status,
          lower(nullif(btrim(v_meta ->> 'username'), '')),
          left(nullif(btrim(v_meta ->> 'full_name'), ''), 60),
          nullif(btrim(v_meta ->> 'phone'), ''),
          upper(nullif(btrim(v_meta ->> 'country_code'), '')))
  on conflict (user_id) do nothing;
  return new;
end $$;
