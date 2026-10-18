# Production-readiness checklist

**This build is testnet-only and is not production-ready.** `REAL_FUNDS_ENABLED` is hard-refused by both the web server (`src/server/env.ts`) and the worker (`workers/startup-guard.ts`). Mainnet networks cannot be activated, because the `mainnet_not_active` constraint blocks it. Simulated custody and trading refuse to operate on real networks.

Every item below must be complete and signed off before real funds are handled. Removing the guard is the **last** step, made in a reviewed change.

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
- [ ] Monitoring and alerting on critical risk events, dead-lettered jobs, reconciliation discrepancies and automatic pauses.
- [ ] Backups, point-in-time recovery, and tested restores.
- [ ] Daily valuation frequency. The seeded allocation policy is hourly, for local demos only.

## Operational runbooks to write

- [ ] Emergency pause and four-eyes resume.
- [ ] Reconciliation discrepancy investigation.
- [ ] Payout anomalies (`payout_status_conflict`, `payout_verification_mismatch`), which auto-pause withdrawals.
- [ ] Deposit recovery (unsupported token, below minimum, reorged then reappeared).
- [ ] Ledger corrections via `reverse_entry`, with documented approvals.
