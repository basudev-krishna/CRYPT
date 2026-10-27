-- =============================================================================
-- Administrator controls over the referral network
--
-- 1. Sponsor corrections. The sponsor link stays immutable for everyone else;
--    an administrator may change it through private.admin_set_sponsor, which
--    refuses loops and records old/new/reason/who in sponsor_changes.
-- 2. Team positions (left/right). Each member may hold one position under a
--    parent, and each parent has at most one left and one right child. The
--    administrator places and moves members; the database refuses loops and
--    taken positions, and every change is kept in placement_history.
--    Positions are an organisational record: nothing here computes or pays
--    anything from team volume.
-- 3. Administrator bonuses. A manual adjustment can draw on the referral reward
--    fund (operator money) instead of the operator float, as a credit or its
--    reversal only.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Sponsor corrections
-- -----------------------------------------------------------------------------
create table public.sponsor_changes (
  id               bigint generated always as identity primary key,
  user_id          uuid not null references auth.users (id),
  old_sponsor_id   uuid references auth.users (id),
  new_sponsor_id   uuid references auth.users (id),
  reason           text not null check (char_length(btrim(reason)) >= 10),
  changed_by       uuid not null references auth.users (id),
  changed_at       timestamptz not null default now()
);
create index sponsor_changes_user_idx on public.sponsor_changes (user_id, changed_at desc);
create trigger sponsor_changes_immutable before update or delete on public.sponsor_changes
  for each row execute function private.forbid_mutation();

-- The identity guard now lets the sponsor change only inside admin_set_sponsor.
create or replace function private.user_profiles_identity_guard() returns trigger
language plpgsql as $$
begin
  if new.member_code is distinct from old.member_code or new.invitation_id is distinct from old.invitation_id then
    raise exception 'member id and invitation are permanent' using errcode = 'P0001';
  end if;
  if new.sponsor_user_id is distinct from old.sponsor_user_id and coalesce(current_setting('app.sponsor_correction', true), '') <> 'on' then
    raise exception 'member id, sponsor and invitation are permanent' using errcode = 'P0001';
  end if;
  return new;
end $$;

create or replace function private.admin_set_sponsor(p_user uuid, p_sponsor uuid, p_reason text, p_changed_by uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_old uuid;
  v_cursor uuid := p_sponsor;
  v_steps int := 0;
begin
  if char_length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'a reason of at least 10 characters is required' using errcode = 'P0005';
  end if;
  if p_sponsor = p_user then
    raise exception 'a member cannot refer themselves' using errcode = 'P0005';
  end if;
  select sponsor_user_id into v_old from public.user_profiles where user_id = p_user for update;
  if not found then
    raise exception 'member not found' using errcode = 'P0005';
  end if;
  if v_old is not distinct from p_sponsor then
    return;
  end if;
  -- Walk up from the new sponsor: reaching p_user would create a loop.
  while v_cursor is not null loop
    if v_cursor = p_user then
      raise exception 'that would create a referral loop' using errcode = 'P0005';
    end if;
    v_steps := v_steps + 1;
    if v_steps > 10000 then
      raise exception 'referral chain too deep' using errcode = 'P0005';
    end if;
    select sponsor_user_id into v_cursor from public.user_profiles where user_id = v_cursor;
  end loop;
  perform set_config('app.sponsor_correction', 'on', true);
  update public.user_profiles set sponsor_user_id = p_sponsor where user_id = p_user;
  perform set_config('app.sponsor_correction', 'off', true);
  insert into public.sponsor_changes (user_id, old_sponsor_id, new_sponsor_id, reason, changed_by)
  values (p_user, v_old, p_sponsor, btrim(p_reason), p_changed_by);
end $$;

-- -----------------------------------------------------------------------------
-- 2. Team positions
-- -----------------------------------------------------------------------------
create table public.binary_placements (
  user_id         uuid primary key references auth.users (id) on delete restrict,
  parent_user_id  uuid not null references auth.users (id) on delete restrict,
  side            text not null check (side in ('left', 'right')),
  placed_by       uuid not null references auth.users (id),
  placed_at       timestamptz not null default now(),
  constraint not_own_parent check (user_id <> parent_user_id),
  constraint one_child_per_side unique (parent_user_id, side)
);
create index binary_placements_parent_idx on public.binary_placements (parent_user_id);

create or replace function private.binary_placements_no_loop() returns trigger
language plpgsql as $$
declare
  v_cursor uuid := new.parent_user_id;
  v_steps int := 0;
begin
  while v_cursor is not null loop
    if v_cursor = new.user_id then
      raise exception 'that position would put the member under their own team' using errcode = 'P0005';
    end if;
    v_steps := v_steps + 1;
    if v_steps > 10000 then
      raise exception 'team tree too deep' using errcode = 'P0005';
    end if;
    select parent_user_id into v_cursor from public.binary_placements where user_id = v_cursor;
  end loop;
  return new;
end $$;
create trigger binary_placements_no_loop before insert or update on public.binary_placements
  for each row execute function private.binary_placements_no_loop();

create table public.placement_history (
  id               bigint generated always as identity primary key,
  user_id          uuid not null references auth.users (id),
  old_parent_id    uuid references auth.users (id),
  old_side         text,
  new_parent_id    uuid references auth.users (id),
  new_side         text,
  reason           text not null check (char_length(btrim(reason)) >= 10),
  changed_by       uuid not null references auth.users (id),
  changed_at       timestamptz not null default now()
);
create index placement_history_user_idx on public.placement_history (user_id, changed_at desc);
create trigger placement_history_immutable before update or delete on public.placement_history
  for each row execute function private.forbid_mutation();

-- -----------------------------------------------------------------------------
-- 3. Bonuses from the referral reward fund
-- -----------------------------------------------------------------------------
alter table public.manual_adjustments
  add column fund text not null default 'operator_float' check (fund in ('operator_float', 'referral_reward_fund')),
  add constraint referral_fund_credits_only check (fund = 'operator_float' or direction = 'credit' or reverses_adjustment_id is not null);

create or replace function private.manual_adjustments_guard() returns trigger
language plpgsql as $$
begin
  if new.user_id <> old.user_id or new.token_id <> old.token_id or new.direction <> old.direction or new.amount_base <> old.amount_base
     or new.reason <> old.reason or new.reverses_adjustment_id is distinct from old.reverses_adjustment_id or new.created_by <> old.created_by
     or new.fund <> old.fund then
    raise exception 'manual adjustments are immutable apart from their status' using errcode = 'P0005';
  end if;
  if old.status <> 'pending' then
    raise exception 'manual adjustment % is already %', old.id, old.status using errcode = 'P0005';
  end if;
  if pg_has_role(session_user, 'app_web', 'member') and not pg_has_role(session_user, 'app_worker', 'member') and new.status <> 'cancelled' then
    raise exception 'only a pending adjustment can be cancelled' using errcode = 'P0005';
  end if;
  return new;
end $$;

-- -----------------------------------------------------------------------------
-- Access control
-- -----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['sponsor_changes', 'binary_placements', 'placement_history'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('create policy backend_all on public.%I to app_web, app_worker using (true) with check (true)', t);
    execute format('grant select on public.%I to app_web, app_worker', t);
  end loop;
end $$;

grant insert, update, delete on public.binary_placements to app_web;
grant insert on public.placement_history to app_web;
grant insert (fund) on public.manual_adjustments to app_web;

revoke execute on function private.admin_set_sponsor(uuid, uuid, text, uuid), private.binary_placements_no_loop() from public, anon, authenticated;
grant execute on function private.admin_set_sponsor(uuid, uuid, text, uuid) to app_web;
grant execute on function private.binary_placements_no_loop() to app_web, app_worker;
