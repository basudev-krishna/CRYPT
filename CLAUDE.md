# CLAUDE.md

Guide for agents and contributors working in this repository. Read [`docs/accounting.md`](docs/accounting.md) before touching anything financial.

## What this is

EliteWhale is a USDT investment ledger: deposits → pooled investment valued from imported trade executions (unitized NAV) → policy-gated withdrawals. It is testnet-only except for private group mode, which can run with real BSC USDT in a watch-only group wallet (`REAL_FUNDS_ENABLED`, see rule 1). Custody, trading venue, screening and KYC are otherwise simulated or mocked.

## Non-negotiable safety rules

1. **Real funds only in their one supported scope.** Real USDT is allowed only in private group mode on BSC mainnet with manual custody (the app watches the group wallet and holds no keys); see `src/server/phase-guard.ts`. Don't widen that scope or weaken `phase-guard.ts`, `workers/startup-guard.ts`, the `mainnet_allowlist` constraint, `AdapterNotAvailableError` for other mainnets, or the simulated-only checks in custody and venue code. Don't add other mainnet RPCs or token contracts, private keys, seed phrases or real credentials.
2. **Never write the ledger directly.** All balance changes go through `postEntry` (→ `ledger.post_entry`) with a deterministic business idempotency key. Corrections use `ledger.reverse_entry` with a documented reason. Never UPDATE or DELETE `journal_*`, and never add grants that allow it.
3. **No floating point for money.** Use `bigint` base units and 18-dp fixed point (`src/lib/money.ts`). Parse user input with `parseUnits`, which rejects excess precision. Never call `Number()` or `parseFloat` on an amount.
4. **Every financial write runs in one DB transaction** (`withTransaction` / `withWebTransaction`). Lock the payer balance (`lockBalance`) before checking it, and re-check limits under the lock.
5. **Retries must be harmless.** Jobs, API requests and custody calls can run more than once. Use idempotency keys, unique constraints and `on conflict do nothing`, and reuse the same custody key on retry.
6. **Fail closed.** If something is unknown (missing price, unreadable balance, screening down, stale reconciliation, custody/chain disagreement), hold or pause. Never approve, credit or settle on missing information.
7. **Authorization is server-side.** Every route calls `requireUser` / `requirePermission(...)`. Customer queries filter by the session user id. Staff actions need the permission in `src/server/permissions.ts`, a documented note, an audit record, and no self-review. Two-factor is optional for staff by the group's decision (2026-10-27); anyone who enrolled it must still complete it each session. Staff roles are granted/revoked in the console (`src/server/staff.ts`, `staff.manage`), never removing the last admin. Exception: while there is exactly one administrator (`isSoleAdmin`), self-review of deposits/withdrawals and resuming one's own pause (after a 1-hour cooldown) are allowed, but each raises a high-severity risk event (email/Telegram alert). Adding a second admin restores four-eyes automatically. Admin allocations, corrections and manual payouts always raise one.
8. Never claim production readiness. See `docs/production-readiness.md`.

## Architecture map

| Area | Files |
|---|---|
| Ledger | `supabase/migrations/*_ledger.sql`, `*_hardening.sql` (`post_entry`), `src/server/ledger/ledger.ts` |
| Deposits | `src/server/deposits/service.ts` (ingest → refresh → receive into suspense → checks → credit), `src/server/chains/*` |
| Investment | `src/server/investment/{pnl,nav,orders,valuation}.ts`, `src/server/trading/*` |
| Withdrawals | `src/server/withdrawals/{policy,service}.ts` (create → confirm/reserve → payout phases A/B/C → monitor/settle) |
| Treasury | `src/server/treasury/reconciliation.ts` (auto-pauses withdrawals on discrepancy) |
| Group mode | `src/server/deposits/{member-wallets,wallet-proof,allocations}.ts` (shared watched wallet, deposits attributed by signed sender wallet, admin assign/distribute/correct), `src/server/custody/manual.ts` + `src/server/withdrawals/manual-payouts.ts` (admin signs payouts, hash verified on chain), `GROUP_MODE` / `CUSTODY_PROVIDER=manual`, `scripts/setup-staging.ts group-mode` |
| Membership | `src/server/signup.ts` (username/email sign-in, registration fields), `src/server/approvals.ts` (`/admin/approvals`, now only for previously rejected accounts), `*_signup_approval*.sql` (new Auth sign-ups start `active` since `20261028000100`; no admin approval), `*_membership.sql` (member ids, sponsors; invitation gate currently switched off). Referrals: a sign-up's referral id is the permanent sponsor link; `/referrals` and `/admin/referrals` show it, with `referralStage` (qualified = approved + credited deposit). Rewards: `src/server/referrals/rewards.ts`, operator-funded only (`referral_reward_fund`, topped up by allocating an operator receipt), one per referred member, admin-approved, worker-posted; `referral` policy holds amount, start date and EW tiers |
| Network admin | `src/server/referrals/network.ts`, `*_admin_network_controls.sql`: admin sponsor corrections (`private.admin_set_sponsor`, loop-checked, `sponsor_changes`), left/right team positions (`binary_placements`, one child per side, loop-checked, `placement_history`), team tree for admin and member. Sign-up requires a referral id and a left/right choice; the auth trigger places them atomically (`private.place_new_member`, policy `placement_mode` direct/outer; an administrator's referral id is always 'outer', so it never fills up). Admins can place anyone anywhere (`setPlacement` moves a taken spot's member down under the newcomer) and create accounts from `/admin/users` (`src/server/admin-members.ts`, anon-key sign-up on a cookieless client, then `setPlacement`). Bonuses for work are explicit admin awards from `referral_reward_fund` via manual adjustments |
| Matching & ranks | `src/server/referrals/{program,program-math}.ts`, `*_rewards_program.sql`, policy kind `rewards_program`: 10-level matching bonus and rank rewards measured **only** in operator-funded earnings (`reward_base_earnings` view, never deposits, never matching/rank rewards themselves). Worker records (unique per earning+level / member+rank), admin approves only if the pool covers it (`fundPosition`), worker posts `program_reward`. Payouts off by default; matching payouts switched on by the group (migration `20261029000300`). Rank corrections: `rank_achievements` is immutable; admins append revoke/grant rows to `rank_corrections` (`correctRank`, admin user page, high-severity alert) and every read of held ranks goes through the `member_ranks` view; corrected ranks are never re-evaluated or auto-rewarded. `/rewards`, `/admin/rewards` (Reward treasury) |
| Manual adjustments | `src/server/adjustments/manual.ts`, `*_manual_adjustments.sql`: admin credit/debit of a member's platform balance for money settled personally, always against `operator_float` (operator money received in the group wallet, never negative), so no money is created. Income: credits from `referral_reward_fund` (bonuses) and debits back into it (income corrections, event `income_correction`, for money paid by mistake); both count in operator-funded earnings. Web records, worker posts; fixes are reversals; always alerted. Admin user page |
| Off-platform holdings | `src/server/offchain/holdings.ts`, `*_offchain_holdings.sql`: append-only memo ledger (micro-USDT) of money members handed the admin personally. Deliberately outside the double-entry ledger and reconciliation, never withdrawable; corrected by reversal; moved on-platform only by matching a posted group-wallet assignment. `/admin/off-platform`, member view `/off-platform` |
| Ops | `src/server/ops.ts` (audit, risk events, notifications, controls, versioned policies) |
| HTTP | `src/server/http/{api,auth,internal}.ts`. `route()` adds CSRF, rate limit and error mapping; `/internal/*` uses HMAC + nonce |
| Worker | `workers/index.ts` (pg-boss queues, scheduler), `workers/handlers.ts` |
| DB roles | `app_web` (web) and `app_worker` (worker), with table and column grants in `*_security.sql` and `*_hardening.sql`. RLS for anon/authenticated |

## Conventions

- TypeScript strict with `noUncheckedIndexedAccess`. Path alias `@/` = `src/`.
- Domain errors subclass `Error` with `name = 'XxxError'` and a lower-snake `code`; the API maps them to 422 with their message. Anything else becomes a generic 500, so put no secrets in domain error messages.
- SQL is hand-written and parameterized (`$1`). Read `numeric` as `::text` and convert with `parseBase` / `parseFixed`.
- Policies (`policy_versions`) are versioned and immutable. Change one by inserting a new version, never by editing.
- Match the existing style: concise doc comments explaining *why*, no ORMs, small pure functions for financial math (`nav.ts`, `pnl.ts`, `policy.ts`) with unit tests.
- Schema changes go in a **new** migration file. Never edit an applied migration.

## Safe development workflow

```bash
npm run db:start && npm run db:reset    # local Supabase, migrations, seed
npm run dev & npm run worker             # app + background jobs
npm run check                            # lint + typecheck + unit tests
npm run test:integration                 # real Postgres (wipes local app data)
npm run test:e2e                         # build + Playwright
```

Before finishing any change:
1. Run `npm run lint`, `npm run typecheck`, `npm test`. For HTTP/auth changes, also run `npm run test:e2e` and `npm run build`.
2. Every financial behaviour change needs a test: an integration test for ledger, concurrency or idempotency effects, a unit test for pure math or policy.
3. After any ledger change, `checkIntegrity()` must return no unbalanced tokens and no cache mismatches.
4. Never commit `.env*` files other than `.env.example`. Run `git status` and review the diff for secrets before committing.
5. Don't push or deploy without explicit authorization.
