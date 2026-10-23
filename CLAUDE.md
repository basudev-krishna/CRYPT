# CLAUDE.md

Guide for agents and contributors working in this repository. Read [`docs/accounting.md`](docs/accounting.md) before touching anything financial.

## What this is

EliteWhale is a **testnet-only** USDT investment ledger: deposits → pooled investment valued from imported trade executions (unitized NAV) → policy-gated withdrawals. Custody, trading venue, screening and KYC are simulated or mocked.

## Non-negotiable safety rules

1. **Never enable real funds.** Don't weaken `src/server/phase-guard.ts`, `workers/startup-guard.ts`, the `mainnet_not_active` constraint, `AdapterNotAvailableError` for mainnets, or the simulated-only checks in custody and venue code. Don't add mainnet RPCs, production token contracts, private keys, seed phrases or real credentials.
2. **Never write the ledger directly.** All balance changes go through `postEntry` (→ `ledger.post_entry`) with a deterministic business idempotency key. Corrections use `ledger.reverse_entry` with a documented reason. Never UPDATE or DELETE `journal_*`, and never add grants that allow it.
3. **No floating point for money.** Use `bigint` base units and 18-dp fixed point (`src/lib/money.ts`). Parse user input with `parseUnits`, which rejects excess precision. Never call `Number()` or `parseFloat` on an amount.
4. **Every financial write runs in one DB transaction** (`withTransaction` / `withWebTransaction`). Lock the payer balance (`lockBalance`) before checking it, and re-check limits under the lock.
5. **Retries must be harmless.** Jobs, API requests and custody calls can run more than once. Use idempotency keys, unique constraints and `on conflict do nothing`, and reuse the same custody key on retry.
6. **Fail closed.** If something is unknown (missing price, unreadable balance, screening down, stale reconciliation, custody/chain disagreement), hold or pause. Never approve, credit or settle on missing information.
7. **Authorization is server-side.** Every route calls `requireUser` / `requirePermission(...)`. Customer queries filter by the session user id. Staff actions need the permission in `src/server/permissions.ts`, an AAL2 session, a documented note, an audit record, and no self-review. Exception: while there is exactly one administrator (`isSoleAdmin`), self-review of deposits/withdrawals and resuming one's own pause (after a 1-hour cooldown) are allowed, but each raises a high-severity risk event (Telegram). Adding a second admin restores four-eyes automatically. Admin allocations, corrections and manual payouts always raise one.
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
| Membership | `src/server/signup.ts` (username/email sign-in, registration fields), `src/server/approvals.ts` (admin approval of new sign-ups, `/admin/approvals`), `*_signup_approval*.sql` (new Auth sign-ups start `pending_approval`), `*_membership.sql` (member ids, sponsors; invitation gate currently switched off) |
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
