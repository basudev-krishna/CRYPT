# Production-readiness checklist

**This build is not production-ready.** Real funds are possible in one narrow shape only: private group mode on BNB Smart Chain, where the app watches the group wallet and holds no keys (2026-10-24, at the owner's direction, without the testnet rehearsal). `REAL_FUNDS_ENABLED=true` is refused by the web server (`src/server/env.ts`) and the worker (`workers/startup-guard.ts`) unless `APP_ENV=production`, `GROUP_MODE=true`, `CUSTODY_PROVIDER=manual`, `DEMO_MODE=false` and `RPC_URL_BSC_MAINNET` are all set. The `mainnet_allowlist` constraint lets only `bsc-mainnet` (chain 56) be activated. Simulated custody and trading still refuse real networks, and the investment pool stays off.

The items below remain open. Anything beyond the group-wallet scope (pooled investment, a custody provider, other networks) still needs them signed off first.

## Independent reviews (mandatory)

- [ ] Legal and regulatory review of the product in every target jurisdiction: licensing (e.g. VASP/MSB/investment fund), offering documents, terms, risk disclosures, marketing.
- [ ] Independent security audit and penetration test of the application, database roles and infrastructure.
- [ ] Custody architecture review, covering key ceremony, MPC/HSM policy, withdrawal approval quorum and disaster recovery.
- [ ] Accounting and audit review of the NAV methodology, fee calculation and reconciliation procedures (`docs/accounting.md`).

## Integrations not implemented in this build

- [ ] **Custody provider** (e.g. Fireblocks, BitGo, Cobo). Implement `CustodyProvider` with idempotent transfer submission keyed by `custody_request_id`, signed webhooks, and a proven `dropped`/`failed` status. Only `SimulatedCustodyProvider` exists today.
- [ ] **Trading venue.** Implement `TradingVenue` with read-only keys held only by the worker. Add a real capital transfer workflow; `recordTransfer` throws for non-simulated pools.
- [ ] **Sanctions and wallet screening** (e.g. Chainalysis, TRM, Elliptic) to replace `MockScreeningProvider`.
- [ ] **KYC vendor** with document and liveness checks to replace manual review.
- [ ] **Email delivery** for notifications. Email notifications are currently marked `failed`.
- [ ] **TRON adapter** (base58check addresses, TRC-20 events, finality rules).
- [ ] **Production USDT contracts.** Verify each contract address and decimals against Tether's official publication, then add it through a reviewed migration. Never via the UI.

## Security hardening still open

- [x] Constrain `ledger.post_entry` per role. The web role may only post the six entry kinds it needs, each bound to its source row (`20261018000100_web_posting_scope.sql`); app_worker is unrestricted.
- [ ] Rate-limit source IP: set `TRUSTED_PROXY_HOPS` to match the real proxy chain and verify it in staging.
- [ ] Secrets in a secret manager, rotated. Database role passwords must not be the `seed.sql` values.
- [ ] MFA required for every customer at withdrawal (policy `require_mfa=true`) and for all staff (AAL2 is already enforced server-side). Consider WebAuthn.
- [x] Monitoring and alerting on critical risk events, dead-lettered jobs, reconciliation discrepancies and automatic pauses. High/critical risk events go by email (SMTP) and/or Telegram (`src/server/alerts.ts`); the worker refuses to start in staging/production without at least one channel.
- [ ] Backups, point-in-time recovery, and tested restores.
- [ ] Daily valuation frequency. The seeded allocation policy is hourly, for local demos only.

## Private membership

- [ ] ~~Invitation-only sign-up~~ ~~admin-approved sign-up~~ open sign-up: since 2026-10-28 (`20261028000100_signup_approval_not_required.sql`) new Auth sign-ups start `active` with no admin approval, and accounts pending at that time were activated. Previously (`20261023000200_signup_approval.sql`, `/admin/approvals`) they started `pending_approval` and every customer page, API, deposit, order and withdrawal refused them until an admin approved; that queue now only serves accounts rejected earlier. Integration and e2e tests written, not yet run. Sign-in accepts a username or email and registration collects name, username, phone, country and an optional referral id (`src/server/signup.ts`, `20261023000300_signup_profile_fields.sql`). Both run through server routes (`/api/auth/login`, `/api/auth/register`), so Supabase Auth sees the app server's IP: before launch, raise or re-key Auth's per-IP sign-in limits (or forward the client IP) so members don't share one bucket. Previously: invitation-only sign-up, enforced in the database (`20261022000100_membership.sql`). Admins issue single-use, email-bound, expiring invitations (`/admin/members`, permission `member.invite`). Only a hash of each code is stored.
- [x] Email verification required before sign-in (`enable_confirmations = true`, `requireUser`).
- [x] Permanent member ids (`EW-000001`) and sponsor links recorded at sign-up. Sponsor links carry no payouts.
- [ ] Production auth settings: custom SMTP for verification and recovery mail, Auth rate limits, and `site_url`/redirect allowlist for the real domain.
- [ ] Decide whether customers must enrol MFA at sign-up (today: required for staff, and for withdrawals once policy `require_mfa=true`).

## Private group mode (in progress)

Decided 2026-10-24: no trading. Members deposit USDT into one group wallet the app only watches (it holds no keys); the single administrator keeps the ledger. Members see only their own balance and history. Built. Integration tests (`tests/integration/group-wallet.test.ts`, `group-admin.test.ts`) pass against the hosted test project (2026-10-24), as does the rest of the suite; the 9 sign-up approval tests that impersonate Supabase Auth are skipped there and must still be run locally.

- [ ] Group-wallet deposits attributed by sender (`20261024000100_group_wallet_deposits.sql`). Members register sending wallets with a signed ownership proof; deposits from unknown senders (exchange withdrawals) are received into suspense as `under_review`/`unattributed`.
- [ ] Admin allocations (`20261024000200_admin_allocations_manual_payouts.sql`, `/admin/deposits`): assign an unattributed receipt to one member, or split it as a distribution. Lines must add up exactly to a receipt already confirmed on chain. Posted by the worker.
- [ ] Corrections: reverse a credited group-wallet deposit back to suspense, then re-allocate. Fails safely if the member has already spent the credit.
- [ ] Manual payouts (`CUSTODY_PROVIDER=manual`, `/admin/withdrawals`): the admin sends from the group wallet and records the hash; it is checked on chain at entry (sender, recipient, token, exact net amount) and again before settlement. Declining releases the reservation.
- [ ] Single administrator: no second approver exists, so transparency is the control. Every allocation, correction, manual payout, self-review and self-resume raises a high-severity risk event (Telegram), is audited, and shows in the affected member's history with its reason. The app cannot stop an administrator who holds the wallet keys from moving funds on chain; members can verify the wallet balance on the explorer, and reconciliation pauses withdrawals on any ledger/chain difference.
- [ ] Investment pool off (`GROUP_MODE=true` hides portfolio/trading; `setup-staging.ts group-mode` inserts policy versions with `auto_subscribe=false` and KYC replaced by sign-up approval, and pauses pools).
- [ ] Rehearse the full flow on BSC testnet with a test token and a testnet group wallet. **Skipped by the owner's decision; the first real deposits are the rehearsal. Start with small amounts.**
- [x] Go-live change built (`20261024000300_bsc_mainnet_group_wallet.sql`, `phase-guard.ts`, `setup-staging.ts group-mode bsc-mainnet`): BSC USDT `0x55d398326f99059ff775485246999027b3197955` (Binance-Peg BSC-USD, 18 decimals; decimals re-checked on chain), mainnet adapter only while real funds are scoped, policies rewritten for 18 decimals and minimums of 50 USDT deposit / no withdrawal minimum, no withdrawal fee (`src/server/group-limits.ts`), other networks disabled, real-funds banner and disclosure (version `2026-10-24.live`, members must re-accept). Unit tests and build pass; `tests/integration/mainnet-allowlist.test.ts` not yet run.
- Known gaps in real-funds mode: screening is still the mock (every sender passes unless on `SCREENING_BLOCKLIST`); there is one administrator, so no second approver; the DB role passwords shared in chat on 2026-10-23 were rotated by the owner on 2026-10-24.

## Open business decisions (block the related features)

These change financial obligations, so they are not built until decided in writing:

- **Return model.** Today returns are the pool's actual result (unitized NAV). Fixed daily rates would be a separate, explicit liability and need a named funding source, reserve and liquidity policy, missed-payment, early-exit and maturity rules, and legal sign-off.
- **Referral rewards.** Referral rewards, bonuses for work, a 10-level matching bonus and rank rewards (E1 … Emperor) are built (`src/server/referrals/{rewards,program,program-math}.ts`, `20261028000300_rewards_program.sql`, `/rewards`, `/admin/rewards`), all paid only from the operator-funded `referral_reward_fund`, each approved by an administrator, and approval refused unless the pool covers it on top of everything already approved. Matching bases and rank volumes are **operator-funded earnings only** (the `reward_base_earnings` view: entries between the fund and a member's cash, excluding matching/rank rewards themselves), so deposits can never count and rewards never feed rewards. Multi-level team income based on recruits' deposits will not be built. Matching and rank payouts are **off** until an administrator switches them on in a new policy version; the rates, targets and bonuses are provisional. Before switching on: legal review of the compensation plan for every member's country, a written funding source for the pool, and a decision on whether ranks stay permanent (they do today) and volumes stay lifetime totals (they do today). Integration tests (`tests/integration/rewards-program.test.ts`) written, not yet run.
- **Operating entity and jurisdictions**, which decide licensing, KYC/AML and offering-document requirements.
- **Networks.** BEP20 (BSC) is assumed; no TRON work until it is explicitly selected.

## Operational runbooks

Drafted in [`runbooks.md`](runbooks.md). Each must be rehearsed in staging and reviewed before launch. The gaps listed at the end of that file are open defects.

- [x] (drafted) Emergency pause and four-eyes resume.
- [x] (drafted) Reconciliation discrepancy investigation.
- [x] (drafted) Payout anomalies (`payout_status_conflict`, `payout_verification_mismatch`), which auto-pause withdrawals.
- [x] (drafted) Deposit recovery (unsupported token, below minimum, reorged then reappeared).
- [x] (drafted) Ledger corrections via `reverse_entry`, with documented approvals.
- [ ] Close the runbook gaps: ledger adjustment workflow, deposit recovery path, payout-anomaly closure, sweep pause control, offboarding.
