-- =============================================================================
-- Administrators can hold any number of members on each side.
--
-- Until now every parent had at most one child per side (unique constraint),
-- and sign-ups under an administrator went down the chosen side's outer edge.
-- An administrator now has unlimited direct members on the left and on the
-- right, on the same level: sign-ups with an administrator's referral id are
-- placed directly under the administrator, and the administrator can place
-- or move anyone directly under themselves without displacing anyone.
-- Everyone else keeps one member per side, enforced by trigger.
-- =============================================================================

alter table public.binary_placements drop constraint one_child_per_side;

create or replace function private.binary_placements_one_per_side() returns trigger
language plpgsql as $$
begin
  if exists (select 1 from public.staff_roles where user_id = new.parent_user_id and role = 'admin') then
    return new;
  end if;
  -- Serialize placements into the same spot (the unique constraint used to do this).
  perform pg_advisory_xact_lock(hashtext('binary_spot:' || new.parent_user_id::text || ':' || new.side));
  if exists (select 1 from public.binary_placements
              where parent_user_id = new.parent_user_id and side = new.side and user_id <> new.user_id) then
    raise exception 'team position taken: the % side under this member is already taken', new.side using errcode = '23505';
  end if;
  return new;
end $$;
create trigger binary_placements_one_per_side before insert or update of parent_user_id, side on public.binary_placements
  for each row execute function private.binary_placements_one_per_side();

create or replace function private.place_new_member(p_user uuid, p_sponsor uuid, p_side text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_mode   text;
  v_cursor uuid := p_sponsor;
  v_child  uuid;
  v_steps  int := 0;
begin
  if p_side not in ('left', 'right') then
    raise exception 'team position must be left or right' using errcode = 'P0005';
  end if;
  select params ->> 'placement_mode' into v_mode from public.policy_versions
   where kind = 'rewards_program' and effective_from <= now() order by effective_from desc, version desc limit 1;
  v_mode := coalesce(v_mode, 'outer');
  loop
    -- An administrator takes any number of members per side: place directly under them.
    exit when exists (select 1 from public.staff_roles where user_id = v_cursor and role = 'admin');
    -- Lock the candidate parent, then look: a concurrent sign-up for the same
    -- spot waits here and sees the committed child when it continues.
    perform 1 from public.user_profiles where user_id = v_cursor for update;
    select user_id into v_child from public.binary_placements where parent_user_id = v_cursor and side = p_side;
    exit when v_child is null;
    if v_mode = 'direct' then
      raise exception 'team position taken: the % side under this sponsor is already taken', p_side using errcode = 'P0005';
    end if;
    v_cursor := v_child;
    v_steps := v_steps + 1;
    if v_steps > 10000 then
      raise exception 'team tree too deep' using errcode = 'P0005';
    end if;
  end loop;
  insert into public.binary_placements (user_id, parent_user_id, side, placed_by) values (p_user, v_cursor, p_side, p_user);
  insert into public.placement_history (user_id, old_parent_id, old_side, new_parent_id, new_side, reason, changed_by)
  values (p_user, null, null, v_cursor, p_side, 'Chosen by the member at sign-up', p_user);
  return v_cursor;
end $$;

revoke execute on function private.place_new_member(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function private.binary_placements_one_per_side() from public, anon, authenticated;
grant execute on function private.binary_placements_one_per_side() to app_web, app_worker;
