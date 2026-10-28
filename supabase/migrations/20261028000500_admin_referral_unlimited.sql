-- =============================================================================
-- An administrator's referral id never fills up.
--
-- With placement_mode 'direct', a sign-up whose spot directly under the
-- sponsor is taken is refused. For an administrator's referral id that would
-- block new members once both sides are filled, so sign-ups under an
-- administrator always go down the chosen side's outer edge ('outer' mode),
-- whatever the policy says. Other sponsors follow the policy unchanged.
-- =============================================================================

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
  if exists (select 1 from public.staff_roles where user_id = p_sponsor and role = 'admin') then
    v_mode := 'outer';
  end if;
  loop
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
