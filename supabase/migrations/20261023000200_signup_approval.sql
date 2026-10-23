-- =============================================================================
-- Admin-approved sign-up (part 2 of 2)
-- =============================================================================
-- Sign-up is open again (the invitation gate is switched off), but every account
-- created through Supabase Auth starts as 'pending_approval' and cannot use the
-- app until an administrator approves it. Deposits, orders and withdrawals
-- already require account_status = 'active', so a pending or rejected account
-- is blocked everywhere without further changes (fail closed).
--
-- Invitation tables and functions are kept, unused, so the gate can be switched
-- back on later without losing history.

drop trigger if exists on_auth_user_invitation on auth.users;

alter table public.user_profiles
  add column reviewed_at timestamptz,
  add column reviewed_by uuid references auth.users (id) on delete set null;

-- Real sign-ups arrive as supabase_auth_admin and wait for review. Direct
-- inserts by a database superuser (local seed, integration tests, setup
-- scripts) are already fully trusted and start active.
create or replace function private.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_inv record;
begin
  select id, sponsor_user_id into v_inv from public.member_invitations where accepted_user_id = new.id;
  insert into public.user_profiles (user_id, email, sponsor_user_id, invitation_id, account_status)
  values (new.id, coalesce(new.email, ''), v_inv.sponsor_user_id, v_inv.id,
          case when session_user = 'supabase_auth_admin' then 'pending_approval' else 'active' end::public.account_status)
  on conflict (user_id) do nothing;
  return new;
end $$;

grant update (reviewed_at, reviewed_by) on public.user_profiles to app_web;

create index user_profiles_pending_idx on public.user_profiles (created_at) where account_status = 'pending_approval';
