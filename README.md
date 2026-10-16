# EliteWhale: testnet USDT investment ledger

A web app for depositing test USDT, investing it in a pooled strategy valued from real trade executions, and withdrawing it under explicit policy. Every balance comes from an immutable double-entry ledger.

> **Testnet only.** No real funds, keys or mainnet networks. Custody, the trading venue, address screening and KYC are simulated or mocked. Setting `REAL_FUNDS_ENABLED` to anything but `false`/`0` makes the web server and worker refuse to start. See [`docs/production-readiness.md`](docs/production-readiness.md). This build is **not** production-ready.

- Accounting model and invariants: [`docs/accounting.md`](docs/accounting.md)
- Contributor and agent guide: [`CLAUDE.md`](CLAUDE.md)

## Stack

Next.js 16 (App Router, React 19) · Supabase (Postgres + Auth) · `pg` with least-privilege roles · pg-boss durable jobs · viem (EVM testnets) · Tailwind CSS 4 · Vitest · Playwright.

```
src/app/            pages, /api/* route handlers, /internal/* service endpoints (HMAC)
src/server/         domain services: ledger, deposits, investment, withdrawals, treasury, chains, custody
workers/            background worker (pg-boss queues + scheduler)
supabase/migrations 8 SQL migrations (schema, ledger functions, RLS/grants, hardening)
supabase/seed.sql   local reference data (networks, simulated token, pool, policies)
scripts/seed-demo.ts local demo accounts + a simulated deposit
tests/              unit, integration (real local Postgres), e2e (Playwright)
```

## Prerequisites

- **Node.js 22+** and npm 10+
- **Docker Desktop**, running (the local Supabase stack runs in containers)
- The Supabase CLI ships as a dev dependency (`npx supabase …`), so no global install is needed
- For e2e tests: Playwright Chromium (`npx playwright install chromium`)

## Setup

```bash
npm ci
npm run db:start                 # starts local Supabase; prints API URL and keys
cp .env.example .env.local       # then fill in the values below
npm run db:reset                 # applies all migrations + supabase/seed.sql
```

In `.env.local`:
1. Set `NEXT_PUBLIC_SUPABASE_ANON_KEY` to the `anon key` from `npx supabase status`.
2. Generate `INTERNAL_API_SECRET`: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
3. Keep the default local database URLs. The `app_web`/`app_worker` passwords are set by `supabase/seed.sql`.

### Environment variables

| Variable | Used by | Notes |
|---|---|---|
| `APP_ENV` | web | `development`/`test`/`staging`/`production` |
| `REAL_FUNDS_ENABLED` | web, worker, seed | must be `false`; any other value refuses to start |
| `DEMO_MODE` | web | enables `/api/dev/simulate-deposit`; refused when `APP_ENV=production` |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser + server | public Supabase values; the service-role key is never used |
| `DATABASE_URL_WEB` | web | role `app_web` |
| `DATABASE_URL_WORKER` | worker, seed | role `app_worker` |
| `DATABASE_URL_ADMIN` | tests, seed only | local superuser; local host enforced |
| `INTERNAL_API_SECRET` | web | HMAC key for `/internal/*`, at least 32 chars |
| `CUSTODY_PROVIDER` | web, worker | only `simulated` exists |
| `SCREENING_BLOCKLIST` | worker | comma-separated addresses flagged as severe by the mock screener |
| `SIM_PRICE_FEED_DOWN` | worker | `true` simulates a price outage |
| `RPC_URL_EVM_SEPOLIA`, `RPC_URL_EVM_ANVIL`, `RPC_URL_BSC_TESTNET` | web, worker | optional testnet RPCs; those networks are disabled in the seed |
| `TRUSTED_PROXY_HOPS` | web | trusted proxies appending to `X-Forwarded-For` (default 1) |
| `DEMO_PASSWORD`, `E2E_PORT` | tooling | optional |

Server-only variables never reach the browser: only `NEXT_PUBLIC_*` values are bundled, and `src/server/**` imports `server-only`.

## Database migrations

| Command | Effect |
|---|---|
| `npm run db:reset` | drop and recreate the local DB, apply every migration, run `seed.sql` (destroys local data) |
| `npm run db:migrate` | apply pending migrations only (keeps data) |
| `npx supabase migration list --local` | show applied migrations |

Migrations are append-only. Never edit one that has been applied to a shared environment; add a new file instead.

## Running locally

```bash
npm run dev          # web app on http://127.0.0.1:3000
npm run worker       # second terminal: deposits, valuations, payouts, reconciliation
npm run seed:demo    # optional: demo accounts and a 250 tUSDT simulated deposit
```

`seed:demo` creates these accounts. The password is `Demo-Password-2026`, or `$DEMO_PASSWORD` if set.

| Account | Role |
|---|---|
| `demo.investor@example.test` | customer, KYC approved, with a simulated deposit the worker credits within ~30 s |
| `demo.admin@example.test` | staff: admin |
| `demo.compliance@example.test` | staff: compliance |

Staff must enrol TOTP under **Settings → Security** before `/admin` opens, because staff access requires an AAL2 session. Local auth emails (confirmation, reset) are visible in Inbucket/Mailpit at http://127.0.0.1:54324.

The worker loads `.env.local` itself and runs scheduler ticks every 10 s, 5 min and 10 min. It refuses to start without `DATABASE_URL_WORKER`, or when real funds are requested.

## Checks and tests

| Command | What it runs | Needs |
|---|---|---|
| `npm run lint` | ESLint | none |
| `npm run typecheck` | `tsc --noEmit` | none |
| `npm run test:unit` | pure logic, plus the worker real-funds guard (spawns the worker) | none |
| `npm run test:integration` | services against the local Postgres, as `app_web`/`app_worker` | local Supabase running; **wipes local app data** |
| `npm test` | unit + integration | as above |
| `npm run test:e2e` | builds, starts `next start` on :3100 and runs Playwright | local Supabase, Chromium |
| `npm run build` | production build | none |
| `npm run check` | lint + typecheck + unit | none |

Integration and e2e helpers refuse to run against any non-localhost database. Run `npm run db:reset && npm run seed:demo` afterwards to get demo data back.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Invalid server environment: …` | A required variable is missing or malformed in `.env.local`; compare with `.env.example`. |
| `REAL_FUNDS_ENABLED is set … Refusing to start` | Set `REAL_FUNDS_ENABLED=false`. This is intentional. |
| `ECONNREFUSED 127.0.0.1:54322` | Docker or Supabase isn't running: `npm run db:start`. |
| `password authentication failed for user "app_web"` | The seed hasn't run on this database: `npm run db:reset`. |
| `permission denied for schema pgboss` (web enqueue) | Start the worker once; it creates the pg-boss schema and grants `app_web`. |
| Deposits stay `detected`/`confirming` | The worker isn't running, or the network needs more confirmations (simulated blocks advance every 4 s). |
| Deposit `under_review` | Below the 50 tUSDT minimum, KYC not approved, account not active, a large amount, or a risky source. Review it in the admin console. Below-minimum deposits can only be rejected to recovery. |
| Withdrawal stuck `reserved` | Payout policy is holding it: new-destination cooldown, pause, compliance hold, a stale or errored reconciliation, a restricted account, or manual review. Check `risk_result` in the admin console. |
| Withdrawals paused automatically | A reconciliation discrepancy or payout anomaly. Investigate the critical risk event; a *different* admin must resume. |
| `/admin` redirects to Settings → Security | Staff need an MFA-verified (AAL2) session. |
| Playwright `browserType.launch` error | `npx playwright install chromium` |
| Integration tests fail after `db:reset` | Wait a few seconds for the containers to restart, then rerun. |
