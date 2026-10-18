-- =============================================================================
-- Scope what the web role may post to the ledger.
--
-- Until now app_web could call ledger.post_entry with any balanced entry, so a
-- compromised web server could, for example, move suspense funds into any
-- customer's cash or release a reservation whose payout is already in flight.
--
-- The web server only ever posts six kinds of entry (customer subscribe/cancel,
-- withdrawal reserve/release, staff-approved deposit receive/credit). Each one is
-- now bound to its source row: exact account purposes, the source's user, token
-- and amount, the deterministic idempotency key (so it can happen once per
-- source), and a source state in which that entry is legitimate. Everything else
-- is refused for app_web. app_worker is unchanged.
--
-- Source fields the checks rely on must not be writable by app_web, so the
-- blanket UPDATE grant on deposits is narrowed to the columns the web paths set.
-- (withdrawal_requests amounts/user are already immutable via trigger; orders
-- already have column grants and a cancel-only guard.)
-- =============================================================================

revoke update on public.deposits from app_web;
grant update (status, status_reason, risk_result, policy_version_id, suspense_entry_id, credit_entry_id, credited_at) on public.deposits to app_web;

-- -----------------------------------------------------------------------------
-- ledger.assert_web_entry: raise unless the entry is one the web role may post.
-- Called from post_entry before anything is written. Locks the source row so
-- the state check holds until commit.
-- -----------------------------------------------------------------------------
create or replace function ledger.assert_web_entry(
  p_idempotency_key text,
  p_event_type text,
  p_source_type text,
  p_source_id text,
  p_lines jsonb,
  p_reverses_entry_id bigint
) returns void
language plpgsql security definer set search_path = public, ledger, pg_temp as $$
declare
  v_debit record;
  v_credit record;
  v_src record;
  v_expected_source text;
  v_expected_key text;
  v_user uuid;
begin
  if p_reverses_entry_id is not null then
    raise exception 'web role may not post reversals' using errcode = 'P0005';
  end if;
  if jsonb_array_length(p_lines) <> 2
     or (select count(*) from jsonb_array_elements(p_lines) l where l->>'direction' = 'D') <> 1 then
    raise exception 'web entries must be a single debit and a single credit' using errcode = 'P0005';
  end if;

  select a.purpose, a.user_id, a.token_id, (l->>'amount')::numeric(78,0) as amount into v_debit
    from jsonb_array_elements(p_lines) l join public.ledger_accounts a on a.id = (l->>'account_id')::bigint
   where l->>'direction' = 'D';
  select a.purpose, a.user_id, a.token_id, (l->>'amount')::numeric(78,0) as amount into v_credit
    from jsonb_array_elements(p_lines) l join public.ledger_accounts a on a.id = (l->>'account_id')::bigint
   where l->>'direction' = 'C';
  if v_debit.purpose is null or v_credit.purpose is null then
    raise exception 'unknown ledger account' using errcode = 'P0005';
  end if;
  if v_debit.amount <> v_credit.amount or v_debit.token_id <> v_credit.token_id then
    raise exception 'web entries must move one amount of one token' using errcode = 'P0005';
  end if;

  case p_event_type
    -- Customer commits cash to the next NAV strike.
    when 'subscription_requested', 'subscription_cancelled' then
      v_expected_source := 'investment_order';
      v_expected_key := case p_event_type when 'subscription_requested' then 'subscription:request:' else 'subscription:cancel:' end || p_source_id;
      if (p_event_type = 'subscription_requested' and (v_debit.purpose, v_credit.purpose) <> ('user_cash', 'user_pending_subscription'))
         or (p_event_type = 'subscription_cancelled' and (v_debit.purpose, v_credit.purpose) <> ('user_pending_subscription', 'user_cash')) then
        raise exception '% has the wrong accounts', p_event_type using errcode = 'P0005';
      end if;
      select o.user_id, o.kind, o.status, o.amount_base, p.token_id into v_src
        from public.investment_orders o join public.investment_pools p on p.id = o.pool_id
       where o.id::text = p_source_id
         for update of o;
      if not found or v_src.kind <> 'subscription' or v_src.status <> 'pending' then
        raise exception '% needs a pending subscription order', p_event_type using errcode = 'P0005';
      end if;

    -- Customer confirms a withdrawal; staff rejects or customer cancels one.
    when 'withdrawal_reserved', 'withdrawal_released' then
      v_expected_source := 'withdrawal';
      v_expected_key := 'withdrawal:' || p_source_id || case p_event_type when 'withdrawal_reserved' then ':reserve' else ':release' end;
      if (p_event_type = 'withdrawal_reserved' and (v_debit.purpose, v_credit.purpose) <> ('user_cash', 'user_reserved'))
         or (p_event_type = 'withdrawal_released' and (v_debit.purpose, v_credit.purpose) <> ('user_reserved', 'user_cash')) then
        raise exception '% has the wrong accounts', p_event_type using errcode = 'P0005';
      end if;
      select w.user_id, w.status, w.amount_base, w.token_id into v_src
        from public.withdrawal_requests w where w.id::text = p_source_id for update;
      if not found
         or (p_event_type = 'withdrawal_reserved' and v_src.status <> 'pending_verification')
         or (p_event_type = 'withdrawal_released' and v_src.status <> 'reserved') then
        raise exception '% is not allowed in this withdrawal state', p_event_type using errcode = 'P0005';
      end if;
      -- A payout attempt that may still settle on chain keeps the reservation.
      if p_event_type = 'withdrawal_released' and exists (
        select 1 from public.withdrawal_transactions t
         where t.withdrawal_id::text = p_source_id and t.status in ('submitted', 'broadcast', 'confirmed')
      ) then
        raise exception 'withdrawal has a live payout attempt' using errcode = 'P0005';
      end if;

    -- Staff approves a deposit that the worker held for review.
    when 'deposit_received', 'deposit_credit' then
      v_expected_source := 'deposit';
      v_expected_key := case p_event_type when 'deposit_received' then 'deposit:receive:' else 'deposit:credit:' end || p_source_id;
      if (p_event_type = 'deposit_received' and (v_debit.purpose, v_credit.purpose) <> ('treasury_hot', 'suspense_deposits'))
         or (p_event_type = 'deposit_credit' and (v_debit.purpose, v_credit.purpose) <> ('suspense_deposits', 'user_cash')) then
        raise exception '% has the wrong accounts', p_event_type using errcode = 'P0005';
      end if;
      select d.user_id, d.status, d.amount_base, d.token_id, d.confirmations, d.required_confirmations, d.suspense_entry_id into v_src
        from public.deposits d where d.id::text = p_source_id for update;
      if not found or v_src.status <> 'under_review' or v_src.user_id is null or v_src.confirmations < v_src.required_confirmations then
        raise exception '% needs a fully confirmed deposit under review', p_event_type using errcode = 'P0005';
      end if;
      if p_event_type = 'deposit_credit' and v_src.suspense_entry_id is null then
        raise exception 'deposit must be received into suspense before it is credited' using errcode = 'P0005';
      end if;

    else
      raise exception 'web role may not post % entries', p_event_type using errcode = 'P0005';
  end case;

  if p_source_type <> v_expected_source or p_idempotency_key <> v_expected_key then
    raise exception '% must use source % and its deterministic key', p_event_type, v_expected_source using errcode = 'P0005';
  end if;
  if v_debit.amount <> v_src.amount_base or v_debit.token_id <> v_src.token_id then
    raise exception '% amount or token does not match its source', p_event_type using errcode = 'P0005';
  end if;
  -- Every user-scoped account in the entry must belong to the source's user.
  v_user := v_src.user_id;
  if (v_debit.user_id is not null and v_debit.user_id <> v_user) or (v_credit.user_id is not null and v_credit.user_id <> v_user) then
    raise exception '% touches another customer''s account', p_event_type using errcode = 'P0005';
  end if;
end $$;
revoke execute on function ledger.assert_web_entry(text, text, text, text, jsonb, bigint) from public, anon, authenticated, app_web, app_worker;

-- -----------------------------------------------------------------------------
-- ledger.post_entry: unchanged from the hardening migration except for the
-- caller check. This is SECURITY DEFINER, so current_user is the owner;
-- session_user is the login role. Superusers (migrations, tests' admin pool)
-- are members of every role and therefore unrestricted, like app_worker.
-- -----------------------------------------------------------------------------
create or replace function ledger.post_entry(
  p_idempotency_key text,
  p_event_type text,
  p_source_type text,
  p_source_id text,
  p_description text,
  p_posted_by text,
  p_lines jsonb,
  p_metadata jsonb default '{}'::jsonb,
  p_reverses_entry_id bigint default null
) returns bigint
language plpgsql security definer set search_path = public, ledger, pg_temp as $$
declare
  v_entry_id bigint;
  v_hash text;
  v_existing record;
  v_line jsonb;
  v_amount numeric(78,0);
  v_token smallint;
begin
  if p_idempotency_key is null or length(p_idempotency_key) < 8 then
    raise exception 'idempotency key required' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) < 2 then
    raise exception 'an entry needs at least two lines' using errcode = 'P0001';
  end if;
  -- Validate every line before writing anything.
  for v_line in select * from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(v_line->'amount') <> 'string' or (v_line->>'amount') !~ '^[1-9][0-9]{0,77}$' then
      raise exception 'line amounts must be positive integers (base units) given as strings, got %', v_line->'amount' using errcode = 'P0001';
    end if;
    if (v_line->>'direction') is null or (v_line->>'direction') not in ('D', 'C') then
      raise exception 'line direction must be D or C' using errcode = 'P0001';
    end if;
  end loop;

  -- The web role may only post the entries its request paths need (see above).
  if pg_has_role(session_user, 'app_web', 'member') and not pg_has_role(session_user, 'app_worker', 'member') then
    perform ledger.assert_web_entry(p_idempotency_key, p_event_type, p_source_type, p_source_id, p_lines, p_reverses_entry_id);
  end if;

  v_hash := encode(extensions.digest(p_event_type || '|' || p_source_type || '|' || p_source_id || '|' || p_lines::text, 'sha256'), 'hex');

  insert into public.journal_entries
    (idempotency_key, event_type, source_type, source_id, description, payload_hash, reverses_entry_id, posted_by, metadata)
  values
    (p_idempotency_key, p_event_type, p_source_type, p_source_id, p_description, v_hash, p_reverses_entry_id, p_posted_by, coalesce(p_metadata, '{}'::jsonb))
  on conflict (idempotency_key) do nothing
  returning id into v_entry_id;

  if v_entry_id is null then
    select id, payload_hash into v_existing from public.journal_entries where idempotency_key = p_idempotency_key;
    if v_existing.payload_hash <> v_hash then
      raise exception 'idempotency key % reused with different content', p_idempotency_key using errcode = 'P0003';
    end if;
    return v_existing.id;
  end if;

  -- Lock every touched balance row in a canonical (account id) order before
  -- applying lines, so concurrent postings over the same accounts serialize
  -- instead of deadlocking (e.g. A->B and B->A at the same time).
  perform 1 from public.account_balances
   where account_id in (select (l->>'account_id')::bigint from jsonb_array_elements(p_lines) l)
   order by account_id
   for update;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_amount := (v_line->>'amount')::numeric(78,0);
    select token_id into v_token from public.ledger_accounts where id = (v_line->>'account_id')::bigint;
    if v_token is null then
      raise exception 'unknown ledger account %', v_line->>'account_id' using errcode = 'P0001';
    end if;
    insert into public.journal_lines (entry_id, account_id, token_id, direction, amount, memo)
    values (v_entry_id, (v_line->>'account_id')::bigint, v_token, v_line->>'direction', v_amount, v_line->>'memo');
  end loop;

  -- Fail fast (the deferred trigger is the backstop).
  perform 1 from public.journal_lines where entry_id = v_entry_id
   group by token_id having sum(case when direction = 'D' then amount else -amount end) <> 0;
  if found then
    raise exception 'journal entry is unbalanced' using errcode = 'P0001';
  end if;

  return v_entry_id;
end $$;
revoke execute on function ledger.post_entry(text, text, text, text, text, text, jsonb, jsonb, bigint) from public, anon, authenticated;
grant execute on function ledger.post_entry(text, text, text, text, text, text, jsonb, jsonb, bigint) to app_web, app_worker;
