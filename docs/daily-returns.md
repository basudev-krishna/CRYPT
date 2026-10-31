# Fixed daily returns (contractual accrual model)

Status: implemented on the ledger and worker. **Not approved for live use**: the decisions in
[Decisions that need approval](#decisions-that-need-approval) are open. Plans start as drafts and
create no obligations until an administrator activates one.

## What was asked

About 50 participants in the company's own network provide USDT capital. The company promises
compensation at a fixed **0.33% of principal per day** under agreed terms, and intends to pay it from
its business revenue (several investment teams, products and services), not from new participants'
money. The application must accrue that obligation daily, show it honestly, pay it only from
recorded business revenue, and let administrators monitor obligations against funding.

## Assessment of the financial model

A fixed rate is not a problem by itself. Bonds and loans pay fixed rates. What matters is how large
the promise is and where the money to keep it comes from.

**Size of the promise.** 0.33% a day is 1.2045 × principal a year (simple), or about 233% a year if
returns were reinvested daily. On 50,000 USDT of principal that is 165 USDT a day, 60,225 USDT a year.
The business has to earn more than that on the capital, after its own costs, every year, just to stay
level. Legitimate fixed-income products rarely pay more than a low double-digit percentage a year,
so for this rate the evidence that the revenue exists has to be strong.

**What decides whether it is sustainable.** The question is whether returns are paid from revenue the
business earns, or from capital that other participants put in. A ledger can't tell those apart by
itself, because USDT from a revenue source and USDT from a participant look the same in the group
wallet. So the design does three things:

1. It refuses to pay a return from anything except a reserve funded by receipts recorded as business
   revenue.
2. It refuses to record a receipt as revenue when the sender is a known participant wallet.
3. It shows everyone the gap between what has been promised and what has been funded.

If revenue stops, payouts stop and the shortfall is visible. They are never quietly topped up from
principal.

**Remaining risk that software cannot remove.**

- One administrator records revenue, and four-eyes review is off while there is a single admin. An
  administrator who labels a participant's transfer from an unregistered wallet as revenue gets past
  check 2. Every revenue receipt is a high-severity alert, but the real control is an independent
  review of the evidence references.
- The existing referral commission, matching and rank programs are a separate matter. Combined with
  a fixed daily return, regulators in many jurisdictions treat this structure as an unregistered
  investment scheme. Daily-return payouts are deliberately **excluded** from the matching/rank
  earnings base (`reward_base_earnings` counts only `referral_reward_fund` payouts), so the
  10-level matching never multiplies these returns.

## Accounting

New ledger purposes (migration `20261030000100`, `20261030000200`):

| Purpose | Type | Scope | Meaning |
|---|---|---|---|
| `plan_principal` | liability | member | capital committed to a plan; never negative; counted in custody solvency |
| `return_accrued` | liability | member | daily returns accrued, not yet due under the plan terms |
| `return_payable` | liability | member | returns now due, waiting for revenue funding |
| `return_reserve` | liability | platform | business revenue received in the group wallet and set aside for returns; never negative |
| `return_cost` | expense | platform | the company's cost of accrued returns that are **not yet funded** |

Entries (all posted by the worker, each with a deterministic idempotency key):

| Event | Entry | Key |
|---|---|---|
| Subscribe | D `user_cash` / C `plan_principal` | `plan_subscription:<id>:open` |
| Daily accrual | D `return_cost` / C `return_accrued` | `return_accrual:<subscription>:<date>` |
| Return becomes due | D `return_accrued` / C `return_payable` | `return_accrual:<id>:payable` |
| Revenue recorded (allocation `business_revenue`) | D `suspense_deposits` / C `return_reserve` | `allocation:<id>` |
| Return settled from revenue | D `return_payable` / C `user_cash` **and** D `return_reserve` / C `return_cost` | `return_accrual:<id>:settle` |
| Principal returned | D `plan_principal` / C `user_cash` | `plan_subscription:<id>:redeem` |

Invariant: `return_cost` = Σ `return_accrued` + Σ `return_payable` per token. Accruals add to both
sides and settlement removes from both. Reconciliation fails (blocking) if they ever differ.

What each figure means, and what it never means:

- **Accrued** and **payable** are promises, not money. They are never withdrawable, never shown as
  available, and never counted as custody assets.
- **Settled** means credited to the member's available balance from the revenue reserve. It is
  **not** a blockchain payment. The money leaves the wallet only through the normal withdrawal flow,
  where the administrator signs and the transaction hash is verified on chain.
- **Principal** stays in the group wallet and is a customer liability in the solvency check. Moving it
  out to deploy in the business is not supported yet (decision 1).

## Automatic enrolment

A plan created with **auto_enroll** (migration `20261030000500`, `src/server/returns/enroll.ts`)
enrols every member deposit without the member subscribing. Existing deposits are enrolled on the
first worker run after activation, and new ones as they are credited.

- On-platform: each `user_cash` credit from `deposit_credit` or an assignment/distribution
  (`deposit_allocated`), not reversed, becomes a subscription that moves that cash into
  `plan_principal`. It is capped at the member's available cash less pending enrolments, so money
  already withdrawn is not enrolled. Amounts below the plan minimum are left in available balance.
- Offline: each off-platform contribution of a linked member, not reversed, becomes an offline
  subscription.
- Each source is enrolled once (unique `source_line_id` / `source_offchain_entry_id`).
- Accrual starts the day after the money was received, **but never before the plan was activated**,
  so no obligation is created for days before the plan existed.
- Only one automatic plan per token may be active. The worker may insert only automatic
  enrolments into an active automatic plan (database guard).
- Consequence for members: enrolled deposits leave available balance and can be withdrawn only by
  redeeming principal after the plan's lock. Choose the lock accordingly.
- Not enrolled automatically: manual adjustments (admin credits from the operator float or reward
  fund). These mix deposits with rewards, so record those deposits as offline principal instead.
- Known edge: an offline contribution later moved on-platform keeps its offline plan (its
  assignment is not enrolled a second time). Record the offline principal as returned if the member
  should now hold it on the platform.

## Offline principal and payments

Most members hand their principal to the team offline and are paid offline (migration
`20261030000400`, `src/server/returns/offline.ts`, permission `returns.offline`: admin, operations).

- A team member records an **offline subscription** (member, plan, amount, reference to the offline
  receipt). Its principal never enters the double-entry ledger, because no wallet money backs it: it
  is never withdrawable here and never in custody solvency. Members can't redeem it on the platform;
  the team records when it is returned offline (accrual stops that day).
- Its returns **accrue on the ledger like any other**. They are what the company owes.
- A team member records an **offline payment** of a member's due returns through a date:
  D `return_payable` / C `return_cost` per accrual (key `return_accrual:<id>:offline`). Nothing is
  credited to available balance, and it is labelled "Paid offline by the team", never as an on-chain
  payment.
- Offline plans are never paid from the on-chain reserve, so a return can't be paid twice.
- The member's dashboard **Total account value** includes plan principal (on-platform and offline)
  and returns owed (accrued + due), each as a labelled slice. Available balance is unchanged.
- Every offline record needs a reference or note, is audited, and raises a high-severity alert
  (kind suffixed `_self` when staff record it for themselves).

## Running without a worker

With `JOBS_MODE=inline` the deployment has no worker process. Every job an admin action would
queue runs immediately in that request, using the worker's database role and handlers, so the same
ledger rules apply. **Sync & process now** (admin overview and Daily returns) runs one pass of the
worker's schedule: chain scan, deposit credits, pending allocations/adjustments/rewards,
enrolment, accrual, maturity, settlement, offline payments, reconciliation and alerts. Accrual
catches up every missed day.

The pass also runs on a schedule, with nobody at the console: `/internal/cron/sync` (bearer
`CRON_SECRET`, refused when unset or when `JOBS_MODE` isn't `inline`) is called every 30 minutes by
the GitHub workflow `.github/workflows/sync.yml` (repository secrets `SYNC_URL`, `CRON_SECRET`) and
once a day by Vercel Cron (`vercel.json`) as a backstop. Overlapping or repeated passes are harmless.
A day's return becomes visible at the first pass after that UTC day starts.

## Calculation (reproducible)

- Rate is stored as integer parts per million (`daily_rate_ppm`; 0.33% = 3300).
- `accrual = floor(principal_base × daily_rate_ppm / 1 000 000)`. Simple interest on principal, no
  compounding. Rounding down is at most one base unit (1e-18 USDT on BSC).
- Days are UTC calendar days. The first accrual day is the day after the subscription is opened.
  Accrual stops at the term end (`term_days` after the first day) or after the UTC day principal
  redemption is requested (that day is accrued). A day accrues as soon as it starts, so members see
  the day's return on that day; it becomes payable the next day at the earliest.
- Each accrual row stores date, principal, rate, plan, amount and formula, with the journal entry
  ids, so any figure can be recomputed from immutable inputs.
- The worker catches up missed days. A paused or late worker delays accruals but never loses or
  doubles them. `(subscription, date)` is unique and the ledger key is deterministic.
- An accrual becomes payable `payable_after_days` days after the day it was earned.
- Settlement pays the oldest payable returns first, one accrual at a time and only in full. When the
  reserve can't cover the next one, settlement stops (it does not skip ahead to smaller, newer
  amounts), raises a `return_reserve_shortfall` risk event and waits for revenue. Accounts that are
  not active are skipped without blocking others.

## Controls

- Plans: terms (rate, minimum, term, payable delay, principal lock, reference to the approved written
  terms) are immutable once created. A change means a new plan. Activation is by a different
  administrator from the one who created the plan; a sole administrator may do both, which raises a
  high-severity alert. Closing a plan stops new subscriptions. Existing ones keep their terms.
- Revenue: only through allocation kind `business_revenue`. It needs a business line, revenue
  period and evidence reference, and is refused when the sender is an active member wallet or has
  previously funded a member deposit. Always a high-severity alert.
- Company funding wallets (migration `20261030000300`, `src/server/returns/funding.ts`): the team
  sends USDT to the group wallet daily to fund returns. An administrator registers each sending
  address once (always a high-severity alert). The worker then records every unattributed receipt
  from an active funding wallet as `business_revenue` automatically: business line = wallet label,
  evidence = transaction hash, `created_by` = the administrator who registered the wallet. The
  database refuses a funding wallet that is, or has acted as, a member's wallet, refuses member
  wallets that are funding wallets, and lets the worker create no other kind of allocation. With
  `payable_after_days = 0`, each day's return is credited to available balance on the first worker
  run after UTC midnight once the day's funding has arrived; if it hasn't, it is credited as soon as
  it does.
- Pauses (`system_controls`, shown on the console): `return_accruals_paused` delays accrual (days are
  caught up on resume), and `return_settlements_paused` holds all settlement. Resuming follows the
  existing four-eyes / sole-admin cooldown rule.
- Reconciliation: `plan_principal` is a customer liability in solvency. The `return_obligations`
  integrity check is blocking. `return_coverage` (payable > reserve) is a warning shown on the console.

## Decisions that need approval

None of these is invented in code. Where code needs a value, an administrator must enter it on the
plan, citing the approved terms (`terms_reference`).

1. **Capital deployment.** The model says the company uses participants' capital in its business.
   The app can only verify money in the watched wallet. If principal leaves the wallet, solvency
   fails and withdrawals pause. Deploying capital needs a decision on how deployed capital is
   evidenced (counterparty, statements, independent confirmation) and how it is valued, and that
   design hasn't been made.
2. **Legal form.** Whether participants are lenders (fixed-rate notes), investors in a profit-sharing
   arrangement, or something else determines registration, prospectus and exemption duties. A fixed
   return paid on pooled capital is usually a security. This needs counsel in each participant's
   jurisdiction before any plan is activated.
3. **Default and shortfall terms.** What participants are owed when revenue doesn't cover the
   promise: pro-rata versus first-in-first-out, whether accrual continues during a shortfall, and
   whether it continues during an administrative pause. The code continues accruing (a contractual
   obligation does not disappear) and settles oldest first. Both need approval.
4. **Term, maturity and principal return.** Term length, lock-up, early exit (currently not allowed
   before the lock ends), and what happens at term end (currently: accrual stops, principal stays
   until the member requests it).
5. **Caps.** Whether total returns are capped (for example at a multiple of principal). Not
   implemented.
6. **Tax and reporting.** Withholding, annual statements, and how `return_cost` is treated in the
   company's books.
7. **Revenue evidence.** Who independently reviews revenue receipts and their evidence references.
   With one administrator, nobody does today.
8. **Interaction with referral, matching and rank programs.** These are kept separate and never
   based on daily returns. Whether they should run alongside a fixed-return product at all is a
   legal question (see 2).

## Tests

- Unit (`tests/unit/daily-returns.test.ts`): accrual formula, UTC date ranges, term and redemption
  ends, payable dates, FIFO settlement, coverage and runway.
- Integration (`tests/integration/daily-returns.test.ts`): subscription under lock, idempotent
  accrual and catch-up, maturity, settlement only from revenue, shortfall hold, pauses, revenue
  refused from member wallets, principal redemption after lock, the obligation invariant,
  `checkIntegrity()` clean, and solvency counting principal.
