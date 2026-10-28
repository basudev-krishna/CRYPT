# Operational runbooks

**This build is testnet-only and is not production-ready.** These runbooks describe what the code does today. Before any real-funds launch, every runbook must be rehearsed on staging (including the four-eyes resume) and reviewed alongside the items in [`production-readiness.md`](production-readiness.md). Several runbooks end in a gap where the code has no supported way to finish the job. Those gaps are listed in [Known gaps](#known-gaps). Close them before launch.

Read [`accounting.md`](accounting.md) first. The rules below apply to every runbook.

## Rules for every incident

1. **Never edit `journal_entries` or `journal_lines`.** Triggers reject UPDATE and DELETE anyway. Never write `account_balances` or any balance directly. Ledger changes go only through `ledger.post_entry` (application code) or `ledger.reverse_entry` (runbook 5).
2. **Every staff action carries a documented note.** The API enforces at least 10 characters. Write who, what, why and the ticket reference, not "fixed".
3. **No self-review.** Don't review, approve or resolve anything that involves your own account or your own earlier action. The code enforces this for withdrawal review, deposit review, KYC review, account status changes and resume-after-pause. It does **not** enforce it for risk-event resolution or invitations, so follow the rule there by hand.
4. **Fail closed.** If you don't know whether funds moved, assume they may have. Keep the reservation, keep the pause, and escalate.
5. **Use the console.** Every admin route needs a signed-in staff session at AAL2 (MFA) plus the permission below. State-changing routes also reject cross-origin requests. Routes are listed for reference and audit tracing, not for scripting.
6. **SQL in these runbooks is read-only.** Run it on a read-only connection. The only exception is the `ledger.reverse_entry` call in runbook 5.

### Permissions (from `src/server/permissions.ts`)

| Permission | Roles | Used for |
|---|---|---|
| `console.view` | admin, operations, compliance, read_only | all admin pages and GET routes |
| `control.pause` | admin, operations, compliance | pausing a control |
| `control.resume` | admin, plus the four-eyes rule (`canResume`) | resuming a control |
| `jobs.trigger` | admin, operations | Run reconciliation, Import trades, Run valuation |
| `report.export` | admin, operations, compliance | reconciliation CSV export |
| `deposit.investigate` | admin, operations, compliance | Investigate a reported transaction |
| `deposit.review` | admin, compliance | approve or reject a deposit under review |
| `withdrawal.review` | admin, compliance | approve or reject a withdrawal flagged for review |
| `withdrawal.hold` | admin, compliance | place or release a compliance hold |
| `risk.resolve` | admin, compliance | acknowledge or resolve a risk event |
| `user.restrict` | admin, compliance | set account status |
| `member.invite` | admin | issue and revoke invitations |

### Where things show up

| What | Console | API |
|---|---|---|
| Active controls, risk counts, last reconciliation | Admin → Overview (`/admin`) | `GET /api/admin/overview` |
| Open and acknowledged risk events | Admin → Compliance review (`/admin/compliance`) | (page only) |
| Reconciliation runs and latest snapshot | Admin → Treasury & reconciliation (`/admin/treasury`) | `GET /api/admin/reconciliation`, `GET /api/admin/treasury`, `GET /api/admin/reconciliation/export[?runId=]` |
| Audit log (filter by actor id, action prefix) | Admin → Audit log (`/admin/audit`) | `GET /api/admin/audit-events?actor=&action=` |
| High and critical risk events | Telegram, via `notifications.dispatch` (`src/server/alerts.ts`) | — |

Telegram alerts cover **risk events** of severity high or critical only. A manual pause creates no risk event, so it sends no Telegram alert. The only record is an in-app `control_enabled` operations notification and the audit log.

### Worker schedule (`workers/handlers.ts`, `tick`)

| Tick | Every | Enqueues |
|---|---|---|
| fast | 10 s | `chain.ingest` per active network, `withdrawal.process` for `reserved` and `processing`, `withdrawal.monitor` for `broadcast`, `notifications.dispatch`, `ops.maintenance` |
| medium | 5 min | `trades.import` and `valuation.run` per active pool, `treasury.sweep` per active network |
| slow | 10 min | `reconciliation.run` |

Failed jobs retry 5 times with backoff, then go to `dead-letter`. That raises a `job_dead_lettered` risk event (high).

---

## 1. Emergency pause and four-eyes resume

### Controls

`public.system_controls` has one row per key. `enabled = true` means **the pause is on**. If a row is missing, `isControlEnabled` treats it as paused (fail closed).

| Key | What it stops | What keeps running |
|---|---|---|
| `withdrawals_paused` | New requests (`createWithdrawal` fails the `withdrawals_enabled` check). Confirmations (`confirmWithdrawal` throws `paused`, re-checked under the balance lock). **Every custody call** in `processWithdrawal` phase A, including retries of an attempt already submitted. The customer Withdraw page shows the pause. | `withdrawal.monitor` keeps watching `broadcast` payouts, so they can still settle, be released on proven revert, or be marked dropped. A customer can still cancel a `reserved` withdrawal. Staff review and holds still work. `treasury.sweep` custody transfers are **not** paused. |
| `deposits_paused` | Issuing deposit addresses or instructions (`deposits_paused` error). Crediting: `creditDeposit` posts the receive entry into suspense, then returns `deferred`. | Chain ingest and confirmation tracking continue. Confirmed deposits sit in `suspense_deposits` until resume, then the next `chain.ingest` re-enqueues `deposit.credit`. |
| `allocations_paused` | `runValuation` returns `paused` before striking. No NAV, no fee accrual, no execution of pending subscriptions or redemptions. | Trade import. Customers can still place orders, which wait for the next strike. |

### Who can do what

- **Pause:** admin, operations or compliance (`control.pause`).
- **Resume:** admin only (`control.resume`), and `canResume` adds four-eyes: the resuming admin must not be the user in `updated_by` (`staff:<their id>`). Automatic pauses (`service:reconciliation`, `service:withdrawal-monitor`) can be resumed by any admin. Four-eyes doesn't apply to them, so the investigation itself must be reviewed.
- Both use `POST /api/admin/controls` with `{ key, enabled, reason }`, where reason is 10–500 characters. The console form is in Admin → Overview → Emergency controls (Pause / Resume, with a Reason field).
- `setControl` overwrites `reason`, `updated_by` and `updated_at` every time. **Re-pausing a control that is already paused makes you its `updated_by`**, so you can no longer resume it yourself. Don't re-pause just to add a note. Use the incident ticket.
- Four-eyes needs at least two admins with MFA. No route or UI grants staff roles; they are inserted into `public.staff_roles` out of band.

### Trigger / symptoms

- Suspected compromise, custody or chain anomaly, incorrect payouts, a wrong policy version, a pricing failure, or any situation you can't explain.
- Automatic pauses: `reconciliation_discrepancy` (runbook 2), and `payout_status_conflict` / `payout_verification_mismatch` (runbook 3).

### Immediate actions

1. Pause the narrowest control that stops the harm. If in doubt, pause withdrawals: it is the only control that stops funds leaving through payouts.
2. Write a reason that names the incident ticket.
3. Tell the on-call channel yourself. Manual pauses are not sent to Telegram.
4. If the problem involves custody movements, remember that `withdrawals_paused` doesn't stop `treasury.sweep`. The only lever there is to stop the worker process (`SIGTERM` stops it gracefully), and stopping it also stops monitoring and reconciliation.

### Investigation

```sql
-- Current state of every control.
select key, enabled, reason, updated_by, updated_at from public.system_controls order by key;

-- History of pauses and resumes (setControl writes control.enable.<key> / control.disable.<key>).
select created_at, actor_type, actor_id, action, details->>'reason' as reason
  from public.audit_events where action like 'control.%' order by id desc limit 50;

-- Payouts frozen by the pause.
select status, count(*), sum(amount_base)::text as amount_base
  from public.withdrawal_requests
 where status in ('pending_verification', 'reserved', 'processing', 'broadcast') group by status;
```

### Resolution and resume criteria

Resume only when all of these hold:

- the cause is understood and written up in the ticket;
- the related risk events are resolved with notes (Admin → Compliance review);
- for `withdrawals_paused`: the latest finished reconciliation run is `ok` and was started after the fix (runbook 2), and no payout anomaly is still open (runbook 3);
- a **different** admin from the one who paused reviews the write-up and resumes, with a reason that references it.

The code doesn't check these conditions. It checks only the role and four-eyes. Resuming with an open payout anomaly reopens payouts while that withdrawal stays unresolved.

### What NOT to do

- Don't update `system_controls` with SQL. That skips the four-eyes check, the audit record and the reason.
- Don't resume to "see if it clears". Reconciliation and the payout monitor will pause again or hold payouts, and you lose the audit trail of why.
- Don't resume your own pause from a second account.

---

## 2. Reconciliation discrepancy investigation

### What reconciliation compares (`src/server/treasury/reconciliation.ts`)

`runReconciliation` writes one `reconciliation_runs` row and one `treasury_snapshots` row per active network/token. It runs these checks:

| Check | Scope | Blocking | Fails when |
|---|---|---|---|
| `journal_integrity` | ledger | yes | `checkIntegrity()` finds an unbalanced token or a cache mismatch |
| `chain_balance_read` | network/token | yes | a chain balance read throws (the RPC is unavailable) |
| `onchain_vs_ledger` | network/token | yes | `discrepancy ≠ 0`, where `discrepancy = onchain − (ledger treasury_hot + treasury_cold + virtual venue net − in-flight out + pending inbound)` |
| `solvency` | network/token | yes | `treasury + pool_assets < user_cash + user_reserved + user_pending_subscription + pool_investor_equity + suspense_deposits` |
| `venue_vs_ledger` | pool | no (warn) | venue equity differs from ledger `pool_assets` by more than 5% + 1 token |
| `stuck_payouts` | withdrawals | no (warn) | any withdrawal sits in `processing`/`broadcast` with `updated_at` older than 2 h |

Definitions used in `onchain_vs_ledger`:
- **onchain** is the deposit-token balance of every active `treasury_wallets` address plus every `deposit_addresses` address on that network.
- **virtual venue net** is completed virtual `to_venue` transfers minus `from_venue` transfers in `treasury_transfers`.
- **in-flight out** is `net_amount_base` of withdrawals in `broadcast` whose broadcast attempt has `confirmations > 0`.
- **pending inbound** is the amount of deposits in `detected`/`confirming`/`confirmed` with `suspense_entry_id is null`.

### Status and auto-pause

- Any blocking `fail` marks the run `discrepancy`. In one transaction it then: pauses `withdrawals_paused` if not already paused (`updated_by = service:reconciliation`, run row `auto_paused = true`), raises a **critical** `reconciliation_discrepancy` risk event, and queues an operations email notification. Email isn't integrated, so that notification is marked `failed`. Telegram carries the risk event.
- A new risk event is raised on **every** failing run, roughly every 10 minutes, until a run passes.
- An exception during the run marks it `error`. That doesn't pause or raise a risk event directly, but the job retries and eventually dead-letters (`job_dead_lettered`).
- A run left in `running` (worker crash) is ignored by payout checks.
- Separately, if the withdrawal policy has `block_on_reconciliation_discrepancy = true`, `processWithdrawal` holds every new payout while the latest **finished** run (`ok`/`discrepancy`/`error`) is not `ok` or finished more than 6 hours ago. If no run has ever finished, payouts are not held by this check.

### Trigger / symptoms

Telegram `reconciliation_discrepancy` (critical), a red Reconciliation badge on Admin → Overview, "Auto-paused: yes" on Admin → Treasury & reconciliation, or withdrawals held with `reconciliation_clean: hold` in their `risk_result`.

### Immediate actions

1. Confirm withdrawals are paused (Overview → Emergency controls). If the run failed but the control was already on, it stays on under its earlier `updated_by`.
2. Acknowledge (don't resolve) the risk event in Admin → Compliance review, with a note that names the ticket.
3. Export the run: Treasury & reconciliation → **Export CSV**, or `GET /api/admin/reconciliation/export?runId=<id>`. This needs `report.export` and is audited as `report.export.reconciliation`.

### Investigation

```sql
-- Recent runs.
select id, started_at, finished_at, status, triggered_by, auto_paused, summary
  from public.reconciliation_runs order by started_at desc limit 20;

-- Failed and warning checks of one run.
select c->>'name' as check, c->>'scope' as scope, c->>'status' as status, c->'detail' as detail
  from public.reconciliation_runs r, jsonb_array_elements(r.checks) c
 where r.id = :run_id and c->>'status' <> 'ok';

-- The snapshot behind it (wallets = per-address balances that were non-zero, plus all treasury wallets).
select network_id, token_id, onchain_balance_base, ledger_treasury_base, virtual_venue_net_base, in_flight_out_base,
       customer_liabilities_base, pool_assets_base, discrepancy_base, wallets
  from public.treasury_snapshots where reconciliation_run_id = :run_id;
```

Then work through the check that failed.

**`journal_integrity`** reproduces `checkIntegrity()`. Both queries must return no rows:

```sql
select token_id, total_debits, total_credits from public.ledger_trial_balance where total_debits <> total_credits;

select b.account_id, b.balance as cached, ledger.journal_balance(b.account_id) as journal
  from public.account_balances b where b.balance <> ledger.journal_balance(b.account_id);
```

Either one indicates a database-level fault: posting is guarded by triggers and a deferred balance check. Escalate to engineering. Don't post anything to "balance it out".

**`chain_balance_read`**: an RPC or adapter outage. Withdrawals stay paused until a run reads balances again.

**`onchain_vs_ledger`**: a positive discrepancy means tokens on chain that the ledger doesn't expect. Negative means tokens missing. Check each input:

```sql
-- Pending inbound: deposits seen on chain, not yet received into suspense.
select id, status, amount_base, detected_at from public.deposits
 where token_id = :token_id and suspense_entry_id is null and status in ('detected', 'confirming', 'confirmed');

-- Tokens possibly held at deposit addresses but excluded from pending inbound (see runbook 4).
select d.id, d.status, d.status_reason, d.amount_base, c.tx_hash, c.status as chain_status
  from public.deposits d join public.chain_transactions c on c.id = d.chain_transaction_id
 where d.token_id = :token_id and d.suspense_entry_id is null and d.status in ('recovery_required', 'failed');

-- Payouts mined but not settled (counted as in-flight only when confirmations > 0).
select w.id, w.status, w.net_amount_base, t.attempt, t.status as tx_status, t.tx_hash, t.confirmations
  from public.withdrawal_requests w join public.withdrawal_transactions t on t.withdrawal_id = w.id
 where w.token_id = :token_id and w.status in ('processing', 'broadcast') order by w.created_at;

-- Sweeps and venue transfers.
select id, kind, amount_base, status, is_virtual, tx_hash, source_type, source_id, created_at, completed_at
  from public.treasury_transfers where token_id = :token_id order by created_at desc limit 50;

-- Latest ledger activity.
select id, idempotency_key, event_type, source_type, source_id, posted_by, posted_at
  from public.journal_entries order by id desc limit 50;
```

Common explanations:
- A payout mined with 0 confirmations at the moment of the run. It is excluded from in-flight, so it looks like missing funds. The next run should clear it.
- A deposit reorged out and then reappeared, now `recovery_required` without a receive entry. Its tokens look like a surplus. See runbook 4.
- Tokens sent directly to a treasury wallet. No deposit row exists for those, because `recordInboundTransfer` only creates deposits for `deposit_addresses`.

**`solvency`**: compare `customer_liabilities_base` with treasury plus `pool_assets_base`. A shortfall after a valuation usually means a mark-to-market loss larger than treasury cover. Escalate it as a finance incident.

### Resolution

- Fix the cause through the normal flows: wait for confirmations, review or recover the deposit, let the monitor finish the payout. If a posting was genuinely wrong, use runbook 5.
- Trigger a fresh run with **Run reconciliation** (Overview or Treasury, `POST /api/admin/jobs {"job":"reconciliation"}`, permission `jobs.trigger`, audited as `jobs.triggered.reconciliation`).
- No admin route runs `checkIntegrity()` on its own. The reconciliation run's `journal_integrity` check is the supported way to run it.

### Resume / closure criteria

- A run started after the fix finished `ok`, with every blocking check `ok`.
- Each `reconciliation_discrepancy` event from the incident is resolved with a note that names the cause and the clean run id. There may be several.
- Withdrawals are resumed per runbook 1. A run that comes back `ok` does **not** lift the pause automatically.

### What NOT to do

- Don't post entries to make the numbers match. A discrepancy is a symptom.
- Don't deactivate `treasury_wallets` or `deposit_addresses` rows to drop their balances from the check.
- Don't change `block_on_reconciliation_discrepancy` to get payouts moving. Policies change only by inserting a new reviewed version.

---

## 3. Payout anomalies

### Payout phases (`processWithdrawal` in `src/server/withdrawals/service.ts`)

| Phase | Where | What happens |
|---|---|---|
| A | one DB transaction, row locked | No-op unless the status is `reserved`/`processing`. If `withdrawals_paused` or `compliance_hold`, returns `held` with no custody call. If a `submitted` attempt exists, it is reused with the same key. Otherwise `evaluatePayout` runs: reject (reservation released, `rejected`, or `failed` for a replacement), hold, or manual review (`requires_manual_review`). On approve, it inserts a `withdrawal_transactions` attempt with key `wd:<id>:<attempt>` and moves to `processing`. |
| B | outside any transaction | `custody.submitTransfer` with that key. Custody guarantees one transfer per key, so retries are harmless. If custody is unreachable, the job throws and is retried with the same key. |
| C | one DB transaction | Records the custody result. `failed`: reservation released, `failed`, `payout_failed` (high). `submitted`: stays `processing`. `broadcast`: withdrawal moves to `broadcast`. |

`monitorWithdrawal` (runs regardless of pause) then compares custody with the chain:

| Observation | Result | Funds |
|---|---|---|
| Chain `success`, paid the exact net amount of the right token to the destination, enough confirmations | `confirmed`, settle entry `withdrawal:<id>:settle` | leave `user_reserved` |
| Chain `failed` (reverted), or custody `failed` with nothing on chain | `failed`, `payout_reverted` (high) | **released** to `user_cash` |
| Custody `dropped` (or unknown after 30 min) and chain `not_found` | attempt `dropped`, withdrawal back to `processing`, `payout_dropped` (medium), new attempt with a **new** key | stay reserved |
| Chain `success` but custody says `failed` | `payout_status_conflict` (critical) + auto-pause | stay **reserved**, withdrawal stays `broadcast` |
| Chain `success` but the transfer doesn't pay the destination/amount/token | `payout_verification_mismatch` (critical) + auto-pause | stay **reserved**, withdrawal stays `broadcast` |
| Anything else | `pending`, checked again on the next tick | stay reserved |

Other withdrawal risk events: `withdrawal_rejected` (high, payout policy reject), `withdrawal_manual_review` (medium), `payout_failed`, `payout_reverted`, `payout_dropped`.

Funds are released **only** when the payout is proven not executed. Anything ambiguous keeps the reservation.

### Trigger / symptoms

Telegram `payout_status_conflict` or `payout_verification_mismatch`. `withdrawals_paused` set by `service:withdrawal-monitor` with reason `Automatic pause: <kind> on withdrawal <id>`. A `stuck_payouts` warning in reconciliation.

### Immediate actions

1. Confirm withdrawals are paused. `escalatePayoutAnomaly` pauses only if not already paused, and raises one open event per withdrawal and kind.
2. Acknowledge the risk event with a note. **Don't resolve it yet.** If it is resolved while the anomaly persists, the next monitor run raises a new event and pauses again.
3. Contact the custody provider with the `custody_request_id` and `custody_tx_id`.

### Investigation

```sql
select w.id, w.user_id, w.status, w.status_reason, w.amount_base, w.fee_base, w.net_amount_base, w.destination_address,
       w.risk_result, t.attempt, t.custody_request_id, t.custody_tx_id, t.tx_hash, t.status as tx_status,
       t.confirmations, t.error, t.created_at
  from public.withdrawal_requests w join public.withdrawal_transactions t on t.withdrawal_id = w.id
 where w.id = :withdrawal_id order by t.attempt;

select id, kind, severity, status, details, created_at, resolution_note
  from public.risk_events where subject_type = 'withdrawal' and subject_id = :withdrawal_id order by id;

-- Ledger trail: expect reserve, then nothing else while broadcast.
select id, idempotency_key, event_type, posted_by, posted_at
  from public.journal_entries where source_type = 'withdrawal' and source_id = :withdrawal_id order by id;

select created_at, actor_id, action, details from public.audit_events
 where subject_type = 'withdrawal' and subject_id = :withdrawal_id order by id;
```

On a block explorer, check the `tx_hash`: token contract, recipient, amount, status and confirmations. Compare them with `destination_address` and `net_amount_base`.

- **Status conflict:** the chain shows success but custody reports failure. Funds have probably left. Get custody's written account.
- **Verification mismatch:** a mined transaction that isn't the payout we asked for (wrong recipient, amount or token). Treat it as a possible custody compromise. Keep everything paused and escalate to security.

### Resolution

**Gap:** the code has no staff action that settles or fails a withdrawal stuck in `broadcast` after an anomaly. The withdrawal stays `broadcast`, the customer's funds stay in `user_reserved`, and the monitor keeps checking. Resolution depends on what the chain eventually shows:
- If custody corrects its status and the transfer is right, the next monitor run settles it normally.
- Otherwise, closing it needs an engineering change: a reviewed, idempotent worker path with a test. Don't attempt a manual ledger posting.

Before resuming withdrawals for **other** customers, decide in writing, with a second admin, whether it is safe while this withdrawal stays open.

### Resume / closure criteria

- Custody and chain agree on the transaction, and the withdrawal is `confirmed` or `failed` through the monitor.
- The risk event is resolved with a note that states the final on-chain facts.
- The clean reconciliation run and four-eyes resume from runbook 1 are complete.

### What NOT to do

- **Never manually re-broadcast, resubmit, or create a new custody request** for the withdrawal. Duplicate-payout protection relies on one custody key per attempt, and on a new attempt only after custody **proves** the previous one dropped. A manual send outside that path can pay the customer twice, and the ledger will settle only one of them.
- Never release the reservation by hand. A mismatch means funds may already have left.
- Never resolve the risk event to make the pause go away.
- Don't change `withdrawal_requests.status` or `withdrawal_transactions` with SQL. Transitions are enforced by trigger, and a forced transition breaks the audit trail.

---

## 4. Deposit recovery

### Lifecycle (`src/server/deposits/service.ts`)

`detected → confirming → confirmed → credited`. On the way, a deposit can go to `under_review`, `failed` or `recovery_required`.

Accounting has two entries:
- **receive**, `deposit:receive:<id>`: D `treasury_hot` / C `suspense_deposits`, posted at required confirmations.
- **credit**, `deposit:credit:<id>`: D `suspense_deposits` / C `user_cash`.

| Case | How it arises | Status / reason | Risk event | Ledger |
|---|---|---|---|---|
| Unsupported token | Transfer of a token not on the allowlist, native, or disabled. Automatic ingest scans only the network's deposit token contract, so these are normally found only by **Investigate**. | `recovery_required` / `unsupported_token` | `unsupported_token_deposit` (medium) | nothing posted |
| Below minimum | `creditDeposit`: amount below `supported_tokens.min_deposit_base` | `under_review` / `below_minimum` | `deposit_under_review` (low) | received into suspense |
| Other review reasons | `account_not_active`, `kyc_not_approved`, `large_deposit_review`, `source_address_risk` | `under_review` | `deposit_under_review` (low, or high for `source_address_risk`) | received into suspense |
| Reverted or reorged before credit | `refreshDeposit` finds the receipt `failed` or `not_found` | `failed` (chain tx `failed` / `reorged`) | none | nothing posted |
| Reorged, then reappeared | The same `(network, tx_hash, log_index)` is seen again after `failed` + `reorged` | `recovery_required` / `transfer reappeared on chain after being reorged out` | `deposit_reappeared_after_reorg` (high) | nothing posted |
| Verification mismatch | The receipt no longer has the matching log, token, recipient and amount | `recovery_required` / `on-chain transfer no longer matches observed event` | `deposit_verification_mismatch` (high) | nothing posted |
| Rejected in review | Staff reject | `recovery_required` / `rejected: <note>` | none | stays in suspense |

### Staff actions that exist

| Action | Console | API | Permission |
|---|---|---|---|
| Investigate a reported tx | Admin → Deposits → "Investigate a reported transaction" (network, tx hash) | `POST /api/admin/deposits/investigate` `{networkId, txHash}`, which queues `deposit.investigate` | `deposit.investigate` |
| Approve or reject a deposit under review | Admin → Deposits, row action "Approve and credit" / "Reject (recovery)" | `POST /api/admin/deposits/[id]/review` `{decision, note}` | `deposit.review` |

How these behave:
- **Investigate** looks up the receipt and calls `recordInboundTransfer` for every transfer in it. The result isn't shown in the UI. Check the Deposits list for new rows, and the audit log for `deposit.investigation_requested` (web) and `deposit.investigate` (worker; `details.status` is the chain lookup status). A tx with no transfer to a platform deposit address leaves no deposit row.
- **Approve** refuses when the account isn't `active` (`account_restricted`), and always refuses below-minimum deposits (`below_minimum`). The minimum can't be waived. Approve credits the deposit, and auto-subscribes it if the deposit policy says so. Reviewers can't review their own deposit (`conflict_of_interest`).
- **Reject** moves the deposit to `recovery_required`. Funds stay in `suspense_deposits`. The customer isn't notified by this action.

### Immediate actions

1. Don't credit anything outside these two routes.
2. For a reported missing deposit, get the tx hash and network from the customer and run Investigate.
3. For `deposit_reappeared_after_reorg` and `deposit_verification_mismatch`, expect reconciliation to be affected (see below) and check runbook 2.

### Investigation

```sql
select d.id, d.user_id, d.status, d.status_reason, d.amount_base, d.token_id, d.confirmations, d.required_confirmations,
       d.suspense_entry_id, d.credit_entry_id, d.risk_result, d.detected_at,
       c.tx_hash, c.log_index, c.token_contract, c.from_address, c.to_address, c.status as chain_status, c.block_number
  from public.deposits d join public.chain_transactions c on c.id = d.chain_transaction_id
 where d.status in ('under_review', 'recovery_required') order by d.detected_at;

-- Suspense balance per token should equal deposits received but not credited.
select a.token_id, b.balance from public.ledger_accounts a join public.account_balances b on b.account_id = a.id
 where a.purpose = 'suspense_deposits';
select token_id, sum(amount_base) from public.deposits
 where suspense_entry_id is not null and credit_entry_id is null group by token_id;

select id, kind, severity, status, details, created_at from public.risk_events
 where subject_type = 'deposit' and subject_id = :deposit_id order by id;
```

Reconciliation impact: pending inbound counts only `detected`/`confirming`/`confirmed` deposits without a receive entry. By the `onchain_vs_ledger` formula, a deposit-token transfer that is held at a platform address and is `recovery_required` without a receive entry (reappeared after reorg, for example) shows up as an on-chain surplus. Each reconciliation run then fails, and withdrawals are paused. `treasury.sweep` will still sweep that balance to the hot wallet, because it skips only addresses with `detected`/`confirming` deposits. Unsupported tokens are on a different contract and don't affect the check.

### Resolution

**Gap:** the code has no recovery step after `recovery_required`.
- No route moves a deposit out of `recovery_required`.
- No entry type or job returns suspense funds to the sender.
- Nothing posts a receive entry for a reappeared deposit.
- Nothing sweeps or returns unsupported tokens.

What you can do today:
- Record the facts (tx, amounts, sender, decision) in the ticket and in the risk event resolution note.
- For a reappeared deposit that is genuinely final on chain, an engineering change is needed: a reviewed worker path that posts the receive entry and lets the normal review run.
- Return of funds needs a reviewed custody flow with its own idempotency key. Until one exists, recovery is a manual, documented custody operation outside this application, and it leaves suspense unresolved in the ledger. Don't do it on a real-funds system.

### Closure criteria

The deposit's risk events are resolved with notes. Suspense equals the sum of received-but-uncredited deposits. The latest reconciliation run is `ok`.

### What NOT to do

- Don't update `deposits.status`, `suspense_entry_id` or `credit_entry_id` by hand.
- Don't credit a below-minimum or unsupported deposit "as a goodwill gesture". Minimums are a hard rule.
- Don't revive a `failed` reorged deposit. The code deliberately never revives one automatically.

---

## 5. Ledger corrections via `ledger.reverse_entry`

### What the function does (`supabase/migrations/20261017000200_ledger.sql`)

`ledger.reverse_entry(p_entry_id bigint, p_reason text, p_posted_by text)`:
- refuses a missing entry, a reversal (`cannot reverse a reversal`), or a reason shorter than 10 characters;
- posts a mirror entry through `post_entry` with idempotency key `reversal:<id>`, event type `reversal`, source `journal_entry/<id>`, description `Reversal of entry <id>: <reason>`, `metadata.reason`, and `reverses_entry_id = <id>` (unique);
- is idempotent: a second call returns the existing reversal. A different reason in that second call is **not** recorded, because the payload hash excludes the description;
- is executable by **`app_worker` only** (`20261017000700_security.sql`). The web role is refused.
- Customer-owned accounts may not go negative. If the customer has already spent the funds, reversing a credit fails with `P0002`.

### How a correction is actually run

**Gap: no adjustment job, handler, route or UI exists.** `workers/handlers.ts` and `src/server/jobs/queues.ts` have no correction queue. The security migration comment and the user-detail page ("posted by the adjustment workflow") describe a workflow that hasn't been built. Until it exists, a reversal is an exceptional manual database operation. On testnet, follow this procedure:

1. **Approval.** Write the ticket: the entry id, the full reason, and the expected effect on each account. A second person approves in writing. The requester and approver must differ, and neither may be the affected customer.
2. **Contain.** Pause the control that covers the affected flow (runbook 1). For example, pause withdrawals if a `user_cash` balance changes.
3. **Inspect** (read-only):

   ```sql
   select id, idempotency_key, event_type, source_type, source_id, description, posted_by, posted_at, reverses_entry_id
     from public.journal_entries where id = :entry_id;
   select l.id, l.account_id, a.purpose, a.user_id, a.pool_id, l.token_id, l.direction, l.amount, l.memo
     from public.journal_lines l join public.ledger_accounts a on a.id = l.account_id where l.entry_id = :entry_id;
   select id from public.journal_entries where reverses_entry_id = :entry_id;   -- must be empty
   ```

4. **Reverse.** Use a session as `app_worker`, in one transaction, with `p_posted_by` set to `staff:<approver user id>`:

   ```sql
   begin;
   select ledger.reverse_entry(:entry_id, '<ticket ref>: <full reason>', 'staff:<uuid>');
   insert into public.audit_events (actor_type, actor_id, action, subject_type, subject_id, details)
   values ('staff', '<uuid>', 'ledger.reversal', 'journal_entry', ':entry_id', '{"ticket": "...", "approved_by": "..."}'::jsonb);
   commit;
   ```

   `app_worker` has INSERT on `audit_events` and nothing else on the ledger.
5. **Verify.** Trigger **Run reconciliation**. Its `journal_integrity` check is `checkIntegrity()`, and it must report 0 unbalanced tokens and 0 cache mismatches. The run must be `ok` before you resume (runbook 1).

### Limits to understand before reversing

- A reversal only negates. If the correct posting is something else, no code path posts it. The original business idempotency keys (`deposit:credit:<id>`, `withdrawal:<id>:settle`, …) are already used, so a correct re-post needs a reviewed code change.
- Business rows aren't updated. `deposits.credit_entry_id`, `withdrawal_requests.settle_entry_id`/`release_entry_id` and statuses keep pointing at the reversed entry.
- Don't reverse investment entries (subscription/redemption execution, mark-to-market, fees). Units and positions live outside the ledger, and valuation requires `pool_investor_equity` to equal the struck NAV exactly.

### What NOT to do

- Never UPDATE or DELETE `journal_*` (the triggers will refuse anyway), and never write `account_balances`.
- Never grant `reverse_entry` to `app_web`, and never call it from a web request.
- Never reverse without the written second approval and the reason in the call itself.

---

## 6. Membership invitations

> **Currently switched off (2026-10-23).** Sign-up is open. Since 2026-10-28 (`20261028000100_signup_approval_not_required.sql`) new accounts start active with no admin approval; accounts rejected earlier can still be approved in Admin → Sign-up approvals. Before that, every new account waited in Admin → Sign-up approvals (`/admin/approvals`, permission `user.approve`, admin only) until an administrator approves or rejects it with a documented note (audited as `user.signup.approved` / `user.signup.rejected`; self-review is refused). Pending and rejected accounts can sign in but only see `/pending-approval`. The invitation gate trigger was dropped in `20261023000200_signup_approval.sql`; the tables and the procedure below are kept for when it is switched back on.

Membership is invitation-only. Members, invitations and offboarding are managed at Admin → Invitations (`/admin/members`) and Admin → Users.

### Issue an invitation

- Permission `member.invite` (admin only), on an AAL2 session. Non-admins see the list but get "Only administrators can issue invitations."
- Form fields: email, optional sponsor member id (`EW-000001`), validity (7, 14 or 30 days; the API accepts 1–30, default 14) and a documented reason (10–500 characters). Calls `POST /api/admin/invitations`, rate-limited to 20 per hour per IP. Audited as `member.invitation_issued`.
- `issueInvitation` refuses:
  - an email that already has an account (`already_member`);
  - a sponsor id that isn't an **active** member (`sponsor_not_found`);
  - an email that already has a pending invitation (`invitation_pending`). This includes a pending invitation that has **expired**: it stays `pending` (the list shows it as "expired") and blocks a new one until it is revoked.
- **The code is shown once**, together with a `/register?invite=…&email=…` link. Only a SHA-256 hash is stored (`member_invitations.code_hash`). Deliver it out of band over a channel you trust, never in the ticket. If it is lost, revoke and reissue.

### What the invitee does

- They sign up with the code and the **same email**. The DB trigger `private.consume_invitation` on `auth.users` accepts only a pending, unexpired invitation whose hash and email match. It marks the invitation `accepted` in the same transaction and strips the code from user metadata. Otherwise the sign-up is rolled back with `invitation_required` (the form shows "That invitation is invalid, expired, already used, or for a different email address.").
- The profile gets a permanent `member_code` (`EW-` + sequence) and the invitation's sponsor.
- Email verification is required before sign-in: `requireUser` returns `email_unverified` until it is done.
- The invitation is consumed at sign-up, **before** verification. If the invitee never verifies, the email already has an account, so a new invitation is refused (`already_member`). No admin tool deletes or re-sends for that account.

### Revoke

Use Revoke on a pending row (reason of at least 10 characters), which calls `POST /api/admin/invitations/[id]/revoke` (`member.invite`) and is audited as `member.invitation_revoked`. Only `pending` invitations can be revoked (`not_pending` otherwise). Invitations can't be deleted.

### Offboard a member

- Use Admin → Users → user → Account status, which calls `POST /api/admin/users/[id]/status` `{status, reason}` (`user.restrict`, admin or compliance; you can't change your own status). Allowed values are `active`, `restricted` and `frozen`. `closed` exists in the enum but can't be set through the route.
- Effects of any non-active status:
  - new deposit addresses, withdrawal requests and subscriptions are refused;
  - incoming deposits go to `under_review` (`account_not_active`).
- At payout, a `restricted` account is **held** and a `frozen` account is **rejected**, which releases the reservation.
- A status change doesn't sign the user out or block sign-in. They can still view their account.
- A non-active member can't withdraw their remaining balance, because requests require `active`. Settle balances **before** restricting, unless a compliance reason requires otherwise.

### Permanent data

`member_code`, `sponsor_user_id` and `invitation_id` can never change (`private.user_profiles_identity_guard`). Sponsor links record who vouched for whom. **They carry no payouts**: nothing in the code pays a referral.

### What NOT to do

- Don't insert, update or delete `member_invitations` or `user_profiles` identity columns with SQL.
- Don't put invitation codes in tickets, chat logs or the reason field.
- Don't invite someone you are sponsoring and approve your own invitation note. The code doesn't enforce self-review here, so use a second admin.

---

## Known gaps

These are defects or missing capabilities found while writing the runbooks. Each one blocks a runbook from finishing cleanly.

1. **No ledger adjustment workflow.** `reverse_entry` is granted to `app_worker` "via the admin-approved adjustment job", but no such job, handler, route or UI exists. There is also no path to post the corrected replacement entry, and a reversal doesn't update the business rows it relates to.
2. **No deposit recovery path.** `recovery_required` is terminal in practice. No action moves a deposit out of it or returns suspense funds or unsupported tokens to the sender, and nothing posts a receive entry for a deposit that reappeared after a reorg.
3. **Reappeared or mismatched deposits can keep reconciliation failing.** Their on-chain tokens aren't counted as pending inbound, so the result is a recurring `onchain_vs_ledger` discrepancy and auto-pause that no supported action clears.
4. **No resolution path for payout anomalies.** A `payout_status_conflict` or `payout_verification_mismatch` withdrawal stays `broadcast` with funds reserved indefinitely. Resolving its risk event while the anomaly persists re-raises it and re-pauses.
5. **Manual pauses aren't alerted.** They create no risk event, so nothing goes to Telegram. Resumes send no notification at all.
6. **`withdrawals_paused` doesn't stop `treasury.sweep` custody transfers.** No control pauses sweeps. The only lever is stopping the worker.
7. **Re-pausing overwrites `updated_by`.** That silently changes who may resume. There is also no staff-role management, so four-eyes depends on two admins being provisioned out of band.
8. **Reconciliation raises a new critical risk event every failing run**, with no de-duplication, so alerts repeat about every 10 minutes.
9. **Deposit investigation results aren't surfaced.** The outcome (`not_found`, `pending`, `reverted`, `no_transfer_to_platform`) is only implied by the audit log's lookup status.
10. **Risk-event resolution has no self-review check** and doesn't verify that the underlying condition has cleared.
11. **Offboarding is incomplete.** `closed` can't be set, a status change doesn't end sessions, a non-active member has no way to withdraw their balance, and an invitee who never verifies email can't be cleaned up or re-invited.
12. **`checkIntegrity()` has no standalone admin trigger.** It runs only inside a reconciliation run.
