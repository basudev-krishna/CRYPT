-- =============================================================================
-- Double-entry ledger
--
-- * journal_entries / journal_lines are the source of truth for every balance.
-- * Posted entries are immutable; corrections are reversing entries.
-- * Each entry must balance (sum of debits = sum of credits) per token.
-- * account_balances is a derived cache maintained by trigger. It exists so a
--   balance row can be locked (SELECT ... FOR UPDATE) to serialize spends, and
--   so non-negative constraints on customer accounts are enforced atomically.
--   Reconciliation verifies the cache against the journal.
-- * The only write path is ledger.post_entry / ledger.reverse_entry.
-- =============================================================================

create type public.account_type as enum ('asset', 'liability', 'equity', 'revenue', 'expense');

-- What an account represents. Customer-owned purposes are listed in
-- ledger.is_customer_purpose() and may never go negative.
create type public.account_purpose as enum (
  'treasury_hot',              -- asset: on-chain hot wallet + deposit addresses
  'treasury_cold',             -- asset: cold storage
  'pool_assets',               -- asset: investment pool holdings at trading venue (marked to market)
  'user_cash',                 -- liability: customer settled, uninvested, withdrawable funds
  'user_reserved',             -- liability: customer funds reserved for pending withdrawals
  'user_pending_subscription', -- liability: customer funds awaiting the next NAV strike
  'pool_investor_equity',      -- liability: amount owed to pool unit holders (units x NAV)
  'pool_fees_payable',         -- liability: fees accrued by the pool, owed to the platform
  'suspense_deposits',         -- liability: received funds not attributable/creditable yet
  'fee_revenue',               -- revenue: platform fees earned (withdrawal fees, settled pool fees)
  'network_fee_expense',       -- expense: gas paid by the platform
  'owner_equity'               -- equity: capital contributed by the operator
);

create table public.ledger_accounts (
  id          bigint generated always as identity primary key,
  code        text not null unique,
  type        public.account_type not null,
  purpose     public.account_purpose not null,
  token_id    smallint not null references public.supported_tokens (id),
  user_id     uuid references auth.users (id) on delete restrict,
  pool_id     smallint,           -- FK added in the investment migration
  created_at  timestamptz not null default now(),
  constraint user_scoped check (
    (purpose in ('user_cash', 'user_reserved', 'user_pending_subscription')) = (user_id is not null)
  ),
  constraint pool_scoped check (
    (purpose in ('pool_assets', 'pool_investor_equity', 'pool_fees_payable')) = (pool_id is not null)
  )
);
create unique index ledger_accounts_identity_uq
  on public.ledger_accounts (purpose, token_id, user_id, pool_id) nulls not distinct;
create index ledger_accounts_user_idx on public.ledger_accounts (user_id) where user_id is not null;

create table public.journal_entries (
  id                 bigint generated always as identity primary key,
  idempotency_key    text not null unique,
  event_type         text not null,   -- business event, e.g. deposit_credit
  source_type        text not null,   -- e.g. deposit, withdrawal, valuation
  source_id          text not null,   -- business-event identifier
  description        text not null,
  payload_hash       text not null,   -- detects idempotency-key reuse with different content
  reverses_entry_id  bigint unique references public.journal_entries (id),
  posted_by          text not null,   -- 'service:<name>' or 'staff:<uuid>'
  posted_at          timestamptz not null default now(),
  metadata           jsonb not null default '{}'::jsonb
);
create index journal_entries_source_idx on public.journal_entries (source_type, source_id);
create index journal_entries_posted_idx on public.journal_entries (posted_at desc);

create table public.journal_lines (
  id          bigint generated always as identity primary key,
  entry_id    bigint not null references public.journal_entries (id),
  account_id  bigint not null references public.ledger_accounts (id),
  token_id    smallint not null references public.supported_tokens (id),
  direction   char(1) not null check (direction in ('D', 'C')),
  amount      numeric(78,0) not null check (amount > 0),
  memo        text
);
create index journal_lines_entry_idx on public.journal_lines (entry_id);
create index journal_lines_account_idx on public.journal_lines (account_id, entry_id);

create table public.account_balances (
  account_id  bigint primary key references public.ledger_accounts (id),
  balance     numeric(78,0) not null default 0,  -- in the account's normal direction
  line_count  bigint not null default 0,
  updated_at  timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------
create or replace function ledger.normal_side(p_type public.account_type) returns char(1)
language sql immutable as $$
  select case when p_type in ('asset', 'expense') then 'D' else 'C' end
$$;

create or replace function ledger.is_customer_purpose(p public.account_purpose) returns boolean
language sql immutable as $$
  select p in ('user_cash', 'user_reserved', 'user_pending_subscription', 'pool_investor_equity', 'suspense_deposits')
$$;

create or replace function ledger.purpose_type(p public.account_purpose) returns public.account_type
language sql immutable as $$
  select case
    when p in ('treasury_hot', 'treasury_cold', 'pool_assets') then 'asset'::public.account_type
    when p = 'fee_revenue' then 'revenue'::public.account_type
    when p = 'network_fee_expense' then 'expense'::public.account_type
    when p = 'owner_equity' then 'equity'::public.account_type
    else 'liability'::public.account_type
  end
$$;

-- Idempotent account lookup/creation.
create or replace function ledger.ensure_account(
  p_purpose public.account_purpose,
  p_token_id smallint,
  p_user_id uuid default null,
  p_pool_id smallint default null
) returns bigint
language plpgsql security definer set search_path = public, ledger, pg_temp as $$
declare
  v_id bigint;
  v_code text;
begin
  select id into v_id from public.ledger_accounts
   where purpose = p_purpose and token_id = p_token_id
     and user_id is not distinct from p_user_id and pool_id is not distinct from p_pool_id;
  if v_id is not null then
    return v_id;
  end if;

  v_code := p_purpose::text || ':t' || p_token_id
            || coalesce(':u' || p_user_id::text, '')
            || coalesce(':p' || p_pool_id::text, '');
  insert into public.ledger_accounts (code, type, purpose, token_id, user_id, pool_id)
  values (v_code, ledger.purpose_type(p_purpose), p_purpose, p_token_id, p_user_id, p_pool_id)
  on conflict do nothing
  returning id into v_id;

  if v_id is null then  -- created concurrently
    select id into v_id from public.ledger_accounts where code = v_code;
  end if;
  insert into public.account_balances (account_id) values (v_id) on conflict do nothing;
  return v_id;
end $$;

-- -----------------------------------------------------------------------------
-- Immutability and integrity triggers
-- -----------------------------------------------------------------------------
create trigger journal_entries_immutable before update or delete on public.journal_entries
  for each row execute function private.forbid_mutation();
create trigger journal_lines_immutable before update or delete on public.journal_lines
  for each row execute function private.forbid_mutation();

-- Lines may only be added in the same transaction that created the entry.
create or replace function ledger.lines_same_tx() returns trigger
language plpgsql as $$
declare v_posted timestamptz;
begin
  select posted_at into v_posted from public.journal_entries where id = new.entry_id;
  if v_posted is distinct from now() then
    raise exception 'journal lines can only be added while the entry is being posted' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger journal_lines_same_tx before insert on public.journal_lines
  for each row execute function ledger.lines_same_tx();

create or replace function ledger.force_posted_at() returns trigger
language plpgsql as $$
begin
  new.posted_at := now();
  return new;
end $$;
create trigger journal_entries_posted_at before insert on public.journal_entries
  for each row execute function ledger.force_posted_at();

-- Maintain the balance cache and enforce non-negative customer balances.
create or replace function ledger.apply_line() returns trigger
language plpgsql as $$
declare
  v_type public.account_type;
  v_purpose public.account_purpose;
  v_token smallint;
  v_delta numeric(78,0);
  v_new numeric(78,0);
begin
  select type, purpose, token_id into v_type, v_purpose, v_token
    from public.ledger_accounts where id = new.account_id;
  if v_token <> new.token_id then
    raise exception 'line token % does not match account token %', new.token_id, v_token using errcode = 'P0001';
  end if;
  v_delta := case when new.direction = ledger.normal_side(v_type) then new.amount else -new.amount end;

  update public.account_balances
     set balance = balance + v_delta, line_count = line_count + 1, updated_at = now()
   where account_id = new.account_id
  returning balance into v_new;

  if not found then
    insert into public.account_balances (account_id, balance, line_count) values (new.account_id, v_delta, 1)
    returning balance into v_new;
  end if;

  if v_new < 0 and ledger.is_customer_purpose(v_purpose) then
    raise exception 'insufficient balance on account % (%)', new.account_id, v_purpose
      using errcode = 'P0002';
  end if;
  return new;
end $$;
create trigger journal_lines_apply after insert on public.journal_lines
  for each row execute function ledger.apply_line();

-- Deferred check: every entry balances per token at commit time.
create or replace function ledger.check_entry_balanced() returns trigger
language plpgsql as $$
declare v_bad record;
begin
  select token_id,
         sum(case when direction = 'D' then amount else 0 end) as d,
         sum(case when direction = 'C' then amount else 0 end) as c
    into v_bad
    from public.journal_lines where entry_id = new.entry_id
   group by token_id
  having sum(case when direction = 'D' then amount else -amount end) <> 0
   limit 1;
  if found then
    raise exception 'journal entry % is unbalanced for token % (D=% C=%)', new.entry_id, v_bad.token_id, v_bad.d, v_bad.c
      using errcode = 'P0001';
  end if;
  return null;
end $$;
create constraint trigger journal_lines_balanced after insert on public.journal_lines
  deferrable initially deferred for each row execute function ledger.check_entry_balanced();

-- -----------------------------------------------------------------------------
-- Posting API
-- p_lines: [{"account_id": 1, "direction": "D", "amount": "100000000", "memo": "..."}]
-- Returns the entry id. Re-posting with the same idempotency key and identical
-- content returns the original id; different content raises.
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
  v_count int := 0;
begin
  if p_idempotency_key is null or length(p_idempotency_key) < 8 then
    raise exception 'idempotency key required' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) < 2 then
    raise exception 'an entry needs at least two lines' using errcode = 'P0001';
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

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_amount := (v_line->>'amount')::numeric(78,0);
    if v_amount is null or v_amount <= 0 or v_amount <> trunc(v_amount) then
      raise exception 'line amounts must be positive integers (base units)' using errcode = 'P0001';
    end if;
    if (v_line->>'direction') not in ('D', 'C') then
      raise exception 'line direction must be D or C' using errcode = 'P0001';
    end if;
    select token_id into v_token from public.ledger_accounts where id = (v_line->>'account_id')::bigint;
    if v_token is null then
      raise exception 'unknown ledger account %', v_line->>'account_id' using errcode = 'P0001';
    end if;
    insert into public.journal_lines (entry_id, account_id, token_id, direction, amount, memo)
    values (v_entry_id, (v_line->>'account_id')::bigint, v_token, v_line->>'direction', v_amount, v_line->>'memo');
    v_count := v_count + 1;
  end loop;

  -- Fail fast (the deferred trigger is the backstop).
  perform 1 from public.journal_lines where entry_id = v_entry_id
   group by token_id having sum(case when direction = 'D' then amount else -amount end) <> 0;
  if found then
    raise exception 'journal entry is unbalanced' using errcode = 'P0001';
  end if;

  return v_entry_id;
end $$;

create or replace function ledger.reverse_entry(
  p_entry_id bigint,
  p_reason text,
  p_posted_by text
) returns bigint
language plpgsql security definer set search_path = public, ledger, pg_temp as $$
declare
  v_orig public.journal_entries;
  v_lines jsonb;
begin
  select * into v_orig from public.journal_entries where id = p_entry_id;
  if not found then
    raise exception 'entry % not found', p_entry_id using errcode = 'P0001';
  end if;
  if v_orig.reverses_entry_id is not null then
    raise exception 'cannot reverse a reversal' using errcode = 'P0001';
  end if;
  if p_reason is null or length(trim(p_reason)) < 10 then
    raise exception 'a documented reason (>= 10 chars) is required' using errcode = 'P0001';
  end if;

  select jsonb_agg(jsonb_build_object(
           'account_id', account_id,
           'direction', case when direction = 'D' then 'C' else 'D' end,
           'amount', amount::text,
           'memo', 'reversal of line ' || id) order by id)
    into v_lines from public.journal_lines where entry_id = p_entry_id;

  return ledger.post_entry(
    'reversal:' || p_entry_id, 'reversal', 'journal_entry', p_entry_id::text,
    'Reversal of entry ' || p_entry_id || ': ' || p_reason, p_posted_by, v_lines,
    jsonb_build_object('reason', p_reason), p_entry_id);
end $$;

-- Lock an account's balance row until the end of the caller's transaction and
-- return it. Backend roles have no UPDATE privilege on account_balances, so
-- row locking goes through this function.
create or replace function ledger.lock_balance(p_account_id bigint) returns numeric
language plpgsql security definer set search_path = public, ledger, pg_temp as $$
declare v numeric;
begin
  select balance into v from public.account_balances where account_id = p_account_id for update;
  if not found then
    raise exception 'unknown ledger account %', p_account_id using errcode = 'P0001';
  end if;
  return v;
end $$;

-- Balance from the journal (authoritative), in the account's normal direction.
create or replace function ledger.journal_balance(p_account_id bigint) returns numeric
language sql stable security definer set search_path = public, ledger, pg_temp as $$
  select coalesce(sum(case when l.direction = ledger.normal_side(a.type) then l.amount else -l.amount end), 0)
    from public.ledger_accounts a
    left join public.journal_lines l on l.account_id = a.id
   where a.id = p_account_id
$$;

-- Per-user balances by token, derived from the ledger.
create view public.user_ledger_balances with (security_invoker = true) as
select a.user_id, a.token_id,
       coalesce(sum(b.balance) filter (where a.purpose = 'user_cash'), 0)                 as cash_base,
       coalesce(sum(b.balance) filter (where a.purpose = 'user_reserved'), 0)             as reserved_base,
       coalesce(sum(b.balance) filter (where a.purpose = 'user_pending_subscription'), 0) as pending_subscription_base
  from public.ledger_accounts a
  join public.account_balances b on b.account_id = a.id
 where a.user_id is not null
 group by a.user_id, a.token_id;

-- Trial balance per token: must always net to zero.
create view public.ledger_trial_balance with (security_invoker = true) as
select l.token_id,
       sum(case when l.direction = 'D' then l.amount else 0 end) as total_debits,
       sum(case when l.direction = 'C' then l.amount else 0 end) as total_credits
  from public.journal_lines l
 group by l.token_id;
