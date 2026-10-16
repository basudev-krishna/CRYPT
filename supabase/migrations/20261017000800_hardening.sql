-- =============================================================================
-- Hardening (audit follow-up)
--
-- 1. Least privilege for the web role on investment state. Units, cost basis
--    and order execution results are written only by the worker at a NAV
--    strike. The web role may open a position row, lock/unlock units for a
--    redemption request, and create/cancel pending orders - nothing else. A
--    compromised web server can therefore not mint units directly.
-- 2. Replay protection for service-to-service (/internal/*) requests: each
--    signature is accepted at most once.
-- =============================================================================

revoke insert, update on public.investment_positions from app_web;
grant insert (pool_id, user_id) on public.investment_positions to app_web;
grant update (units_locked) on public.investment_positions to app_web;

revoke insert, update on public.investment_orders from app_web;
grant insert (pool_id, user_id, kind, amount_base, units, idempotency_key) on public.investment_orders to app_web;
grant update (request_entry_id, status) on public.investment_orders to app_web;

-- Even with column grants, the web role may only move an order to 'cancelled'.
create or replace function private.web_order_update_guard() returns trigger
language plpgsql as $$
begin
  if current_user = 'app_web' and new.status is distinct from old.status
     and not (old.status = 'pending' and new.status = 'cancelled') then
    raise exception 'web role may only cancel pending orders' using errcode = 'P0004';
  end if;
  return new;
end $$;
create trigger investment_orders_web_guard before update on public.investment_orders
  for each row execute function private.web_order_update_guard();
grant execute on function private.web_order_update_guard() to app_web, app_worker;

-- -----------------------------------------------------------------------------
-- Internal request nonces
-- -----------------------------------------------------------------------------
create table public.internal_request_nonces (
  signature    text primary key,
  received_at  timestamptz not null default now()
);
alter table public.internal_request_nonces enable row level security;
revoke all on public.internal_request_nonces from anon, authenticated;
create policy backend_all on public.internal_request_nonces to app_web, app_worker using (true) with check (true);

-- Returns true the first time a signature is seen, false on any replay.
create or replace function private.claim_internal_nonce(p_signature text) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_claimed boolean;
begin
  insert into public.internal_request_nonces (signature) values (p_signature)
  on conflict (signature) do nothing
  returning true into v_claimed;
  -- Signatures older than the 5-minute timestamp window can no longer be replayed.
  if random() < 0.01 then
    delete from public.internal_request_nonces where received_at < now() - interval '1 hour';
  end if;
  return coalesce(v_claimed, false);
end $$;
revoke execute on function private.claim_internal_nonce(text) from public, anon, authenticated;
grant execute on function private.claim_internal_nonce(text) to app_web;

-- -----------------------------------------------------------------------------
-- 3. ledger.post_entry:
--    * Strict amount validation. The original cast to numeric(78,0) happened
--      before the integer check, so '1.5' was silently rounded to 2 instead of
--      rejected. Amounts must be canonical positive integer strings of base
--      units; anything else (fractions, exponents, signs, leading zeros, JSON
--      numbers) is refused.
--    * Deadlock-free locking: balance rows are locked in account id order.
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
