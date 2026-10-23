-- =============================================================================
-- Private membership: invitation-only sign-up, member ids and sponsors.
--
-- * Staff issue an invitation for one email address. Only a hash of the code is
--   stored; the code itself is shown once and delivered out of band.
-- * A sign-up through Supabase Auth must carry a valid, unexpired invitation for
--   the same email, or the auth.users insert is rolled back. The invitation is
--   consumed in the same transaction, so a code works exactly once.
-- * Every profile gets a permanent member id (EW-000001). The sponsor is fixed
--   from the invitation at sign-up and can never change afterwards. Sponsors
--   must already exist, so the sponsor graph is acyclic by construction.
--
-- Sponsor links are records of who vouched for whom. Nothing in this migration
-- pays anyone for a referral.
-- =============================================================================

create sequence private.member_code_seq;

alter table public.user_profiles
  add column member_code     text,
  add column sponsor_user_id uuid references auth.users (id) on delete restrict,
  add column invitation_id   uuid;

-- Existing accounts get member ids in sign-up order.
update public.user_profiles p
   set member_code = 'EW-' || lpad(nextval('private.member_code_seq')::text, 6, '0')
  from (select user_id from public.user_profiles order by created_at, user_id) o
 where o.user_id = p.user_id;

alter table public.user_profiles
  alter column member_code set not null,
  add constraint user_profiles_member_code_uq unique (member_code),
  add constraint user_profiles_member_code_format check (member_code ~ '^EW-[0-9]{6,}$'),
  add constraint user_profiles_no_self_sponsor check (sponsor_user_id is distinct from user_id);
create index user_profiles_sponsor_idx on public.user_profiles (sponsor_user_id) where sponsor_user_id is not null;

-- Member ids come from the sequence, never from the caller.
create or replace function private.assign_member_code() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  new.member_code := 'EW-' || lpad(nextval('private.member_code_seq')::text, 6, '0');
  return new;
end $$;
create trigger user_profiles_assign_member_code before insert on public.user_profiles
  for each row execute function private.assign_member_code();

create or replace function private.user_profiles_identity_guard() returns trigger
language plpgsql as $$
begin
  if new.member_code is distinct from old.member_code
     or new.sponsor_user_id is distinct from old.sponsor_user_id
     or new.invitation_id is distinct from old.invitation_id then
    raise exception 'member id, sponsor and invitation are permanent' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger user_profiles_identity_guard before update on public.user_profiles
  for each row execute function private.user_profiles_identity_guard();

-- -----------------------------------------------------------------------------
-- Invitations
-- -----------------------------------------------------------------------------
create type public.invitation_status as enum ('pending', 'accepted', 'revoked');

create table public.member_invitations (
  id                uuid primary key default gen_random_uuid(),
  email             text not null check (email = lower(btrim(email)) and email ~ '^[^@\s]+@[^@\s]+$'),
  code_hash         text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  sponsor_user_id   uuid references auth.users (id) on delete restrict,
  note              text not null check (char_length(btrim(note)) >= 10),
  status            public.invitation_status not null default 'pending',
  created_by        text not null,
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null,
  -- Set while auth.users is still being inserted, so the FK is checked at commit.
  accepted_user_id  uuid unique references auth.users (id) on delete restrict deferrable initially deferred,
  accepted_at       timestamptz,
  revoked_by        text,
  revoked_at        timestamptz,
  revoke_reason     text,
  constraint expiry_after_creation check (expires_at > created_at),
  constraint accepted_fields check ((status = 'accepted') = (accepted_user_id is not null and accepted_at is not null)),
  constraint revoked_fields check ((status = 'revoked') = (revoked_by is not null and revoked_at is not null and char_length(btrim(coalesce(revoke_reason, ''))) >= 10))
);
-- One open invitation per address; issuing a new one means revoking the old.
create unique index member_invitations_pending_email_uq on public.member_invitations (email) where status = 'pending';
create index member_invitations_created_idx on public.member_invitations (created_at desc);

/** Codes are compared after dropping separators and case, then hashed. */
create or replace function private.invitation_code_hash(p_code text) returns text
language sql immutable set search_path = pg_temp as $$
  select encode(extensions.digest(upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')), 'sha256'), 'hex')
$$;

-- Only pending invitations change, and backend roles may only revoke them.
-- Acceptance happens solely inside the auth sign-up trigger (owner privileges).
create or replace function private.member_invitations_guard() returns trigger
language plpgsql as $$
begin
  if old.status <> 'pending' then
    raise exception 'invitation % is already %', old.id, old.status using errcode = 'P0001';
  end if;
  if new.status = 'accepted' and current_user in ('app_web', 'app_worker') then
    raise exception 'invitations are accepted only by signing up' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger member_invitations_guard before update on public.member_invitations
  for each row execute function private.member_invitations_guard();
create trigger member_invitations_no_delete before delete on public.member_invitations
  for each row execute function private.forbid_mutation();

-- -----------------------------------------------------------------------------
-- Sign-up gate
-- -----------------------------------------------------------------------------
-- Sign-ups through Supabase Auth connect as supabase_auth_admin and must present
-- a valid invitation in user metadata. Direct inserts by a database superuser
-- (local seed, integration tests) are already fully trusted and are not gated,
-- but still consume an invitation if one is supplied.
create or replace function private.consume_invitation() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_code text := nullif(btrim(new.raw_user_meta_data ->> 'invite_code'), '');
begin
  if v_code is not null or session_user = 'supabase_auth_admin' then
    update public.member_invitations
       set status = 'accepted', accepted_user_id = new.id, accepted_at = now()
     where code_hash = private.invitation_code_hash(v_code)
       and status = 'pending'
       and expires_at > now()
       and email = lower(btrim(new.email));
    if not found then
      raise exception 'invitation_required' using errcode = 'P0010',
        detail = 'Sign-up needs a valid, unexpired invitation for this email address.';
    end if;
  end if;
  -- The code is single-use; don't keep it in client-visible metadata.
  new.raw_user_meta_data := coalesce(new.raw_user_meta_data, '{}'::jsonb) - 'invite_code';
  return new;
end $$;
create trigger on_auth_user_invitation before insert on auth.users
  for each row execute function private.consume_invitation();

create or replace function private.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_inv record;
begin
  select id, sponsor_user_id into v_inv from public.member_invitations where accepted_user_id = new.id;
  insert into public.user_profiles (user_id, email, sponsor_user_id, invitation_id)
  values (new.id, coalesce(new.email, ''), v_inv.sponsor_user_id, v_inv.id)
  on conflict (user_id) do nothing;
  return new;
end $$;

-- -----------------------------------------------------------------------------
-- Access control
-- -----------------------------------------------------------------------------
alter table public.member_invitations enable row level security;
revoke all on public.member_invitations from anon, authenticated;
create policy backend_all on public.member_invitations to app_web, app_worker using (true) with check (true);

grant select on public.member_invitations to app_web, app_worker;
grant insert (email, code_hash, sponsor_user_id, note, created_by, expires_at) on public.member_invitations to app_web;
grant update (status, revoked_by, revoked_at, revoke_reason) on public.member_invitations to app_web;

-- The web role never creates profiles (the auth trigger does), and may only
-- change the columns its routes actually write.
revoke insert, update on public.user_profiles from app_web;
grant update (display_name, country_code, account_status, restriction_reason, risk_disclosure_accepted_at, risk_disclosure_version)
  on public.user_profiles to app_web;

revoke execute on function private.assign_member_code(), private.user_profiles_identity_guard(),
  private.invitation_code_hash(text), private.member_invitations_guard(), private.consume_invitation()
  from public, anon, authenticated;
grant execute on function private.invitation_code_hash(text), private.user_profiles_identity_guard(), private.member_invitations_guard()
  to app_web, app_worker;
