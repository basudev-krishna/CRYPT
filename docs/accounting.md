# Accounting model

This is the accounting reference for EliteWhale. The code is the source of truth. The tests named below check each rule.

## Units and representation

| Quantity | Type | Where |
|---|---|---|
| Token amounts | integer base units (`bigint` in TS, `numeric(78,0)` in SQL). 1 tUSDT = 1 000 000 | everywhere |
| Pool units | 18-dp fixed point (`bigint`, `numeric(48,18)`) | `investment_positions.units` |
| NAV per unit (navpu) | token base units per unit, 18-dp fixed point | `portfolio_valuations.navpu` |
| Trade quantities and prices | 18-dp fixed point | `trade_executions` |

JavaScript `number` is never used for money. The `pg` driver returns `numeric`/`int8` as strings (`configurePgTypes`). `ledger.post_entry` accepts only canonical positive integer strings. Fractions, exponents and JSON numbers are rejected, not rounded (`tests/integration/ledger.test.ts`).

## Ledger accounts

Each account has a purpose, a token, and an optional user or pool scope (`ledger_accounts`).

| Purpose | Type | Meaning |
|---|---|---|
| `treasury_hot`, `treasury_cold` | asset | tokens held on chain |
| `pool_assets` | asset | pool holdings at the trading venue, marked to market at each strike |
| `user_cash` | liability | customer's settled, uninvested, withdrawable funds (**available**) |
| `user_reserved` | liability | funds reserved for pending withdrawals (**pending withdrawals / locked**) |
| `user_pending_subscription` | liability | cash committed to the next NAV strike (**locked**) |
| `pool_investor_equity` | liability | owed to unit holders = units × navpu (**investment NAV**) |
| `pool_fees_payable` | liability | accrued management and performance fees |
| `suspense_deposits` | liability | confirmed receipts not yet credited (under review / recovery) |
| `fee_revenue`, `network_fee_expense`, `owner_equity` | revenue / expense / equity | platform accounts |
| `referral_reward_fund` | liability | operator money set aside for referral rewards; may never go negative |
| `operator_float` | liability | operator money backing manual adjustments; may never go negative |

Customer-owned purposes may never go negative. The `ledger.apply_line` trigger enforces this inside the posting transaction.

Distinct customer figures:
- **Available** = `user_cash`.
- **Locked** = `user_pending_subscription`, plus units locked for redemption (`investment_positions.units_locked`).
- **Pending withdrawals** = `user_reserved`.
- **Investment value** = units × latest navpu.
- **Principal / cost basis** = `investment_positions.cost_basis_base`, the amount subscribed less cost released by redemptions.
- **Realized P&L** = `investment_orders.realized_pnl_base` on executed redemptions (cash out minus cost released).
- **Unrealized P&L** = investment value minus remaining cost basis.

## Invariants (enforced in the database)

1. **Balanced per asset.** The lines of every entry net to zero per token. `post_entry` checks this, and a deferred constraint trigger re-checks it at commit.
2. **Immutable.** `journal_entries` and `journal_lines` reject UPDATE and DELETE, even for the table owner. Corrections are made with `ledger.reverse_entry`, which needs a documented reason (at least 10 characters), can be used once per entry and cannot reverse a reversal. Only `app_worker` may call it.
3. **Single write path.** The backend roles have no INSERT/UPDATE/DELETE on ledger tables. All writes go through the `SECURITY DEFINER` functions `ledger.post_entry` and `ledger.reverse_entry`.
4. **Idempotent.** Every entry has a unique business idempotency key, such as `deposit:credit:<id>` or `withdrawal:<id>:reserve`. Re-posting the same content returns the original entry. Different content under the same key raises `P0003`.
5. **Serialized and deadlock-free.** `post_entry` locks every touched `account_balances` row in account-id order before applying lines. Spends that check a balance first take `ledger.lock_balance` (SELECT … FOR UPDATE) on the payer account.
6. **Derived balances.** `account_balances` is a cache maintained by trigger. Reconciliation re-derives every balance from `journal_lines` and fails on any mismatch.

## Business events

| Event | Entry |
|---|---|
| Deposit confirmed on chain | D `treasury_hot` / C `suspense_deposits` |
| Deposit credited (all checks pass) | D `suspense_deposits` / C `user_cash` |
| Subscription requested | D `user_cash` / C `user_pending_subscription` |
| Subscription executed at strike | D `user_pending_subscription` / C `pool_investor_equity`, plus D `pool_assets` / C `treasury_hot` |
| Mark to market | D/C `pool_assets` against `pool_investor_equity` for the change in GAV |
| Fee accrual | D `pool_investor_equity` / C `pool_fees_payable` |
| Redemption executed | D `pool_investor_equity` / C `user_cash`, plus D `treasury_hot` / C `pool_assets` |
| Withdrawal reserved | D `user_cash` / C `user_reserved` |
| Withdrawal settled | D `user_reserved` / C `treasury_hot` (net) and C `fee_revenue` (fee) |
| Withdrawal released (proven not executed) | D `user_reserved` / C `user_cash` |
| Referral fund top-up (operator receipt allocated by admin) | D `suspense_deposits` / C `referral_reward_fund` |
| Referral reward paid (admin-approved, worker-posted) | D `referral_reward_fund` / C `user_cash` (sponsor) |
| Matching bonus or rank reward paid (admin-approved against the funded pool, worker-posted, event `program_reward`) | D `referral_reward_fund` / C `user_cash` (beneficiary) |
| Operator float top-up (operator receipt allocated by admin) | D `suspense_deposits` / C `operator_float` |
| Manual credit (member paid the admin personally) | D `operator_float` / C `user_cash` |
| Manual debit (admin paid the member personally) | D `user_cash` / C `operator_float` |

Deposits, subscriptions, redemptions and withdrawals are **capital flows**. They never pass through mark-to-market, so they never show up as investment profit or loss (`tests/integration/valuation-scenarios.test.ts`).

## Investment pool: unitized NAV with forward pricing

- Positions come only from **imported venue executions** (`trade_executions`, unique on `(venue, external_execution_id)`, append-only), using weighted-average cost and long only. Fees in the quote asset are paid in cash. Fees in the base asset reduce the quantity received (buy) or add to the quantity disposed (sell).
- Each strike (`runValuation`, one final valuation per pool per period):
  1. GAV = venue cash (net capital transferred + trading cash flows) + open positions × venue prices. Only executions with `executed_at <= strike time` are used, so a strike can be reproduced.
  2. Management fee = GAV × bps × elapsed / year. Performance fee = 10% of the gain per unit above the high-water mark. Fees round down and are capped so NAV ≥ 0.
  3. navpu = NAV / units outstanding. It carries forward when there are no units.
  4. Holders on record *before* the strike get the period result: units × (navpu_end − navpu_start), signed and floored. Realized, unrealized and fee shares are allocated pro rata. They explain the result without changing it.
  5. Pending orders requested before the strike then execute at the **new** navpu (forward pricing). New money therefore never receives gains earned before it joined, and a redemption never takes value from the remaining holders.
- **Rounding** always favours the pool. Units issued and cash paid both round down, and the residual stays with the remaining unit holders.
- **Failure handling.** Invalid executions, missing prices, stale prices (older than 15 min), future-dated prices or a negative GAV record a `failed` valuation with a high-severity risk event. Nothing is allocated, and the period can be retried once prices recover.
- **Integrity.** After posting, ledger `pool_investor_equity` must equal the struck NAV exactly. If it doesn't, the whole valuation transaction rolls back.

Hand-computed scenarios (profitable, losing, unchanged, fees, late subscriber, redemption, reproducibility, stale prices) are in `tests/integration/valuation-scenarios.test.ts`.

## Reconciliation

`runReconciliation` checks, per active network and token:
- journal integrity;
- on-chain balance of all platform addresses = ledger treasury + virtual venue net − in-flight payouts + pending inbound;
- solvency: assets ≥ customer liabilities;
- venue equity vs ledger pool assets (a warning only).

Any blocking failure records a `discrepancy`, raises a critical risk event and **automatically pauses withdrawals**. Payouts are also held when the latest finished run is a discrepancy, an error, or older than 6 hours.

## Off-platform holdings (memo ledger)

Money a member hands the administrator personally is in no platform wallet, so it is **not** in the double-entry ledger. Crediting it as `user_cash` would make customer liabilities exceed on-chain assets: reconciliation would report insolvency and pause withdrawals, and the money would be paid out of other members' deposits.

It is kept in `offchain_entries` instead: append-only, signed micro-USDT per holder, a non-negative balance enforced in the database, and corrections only by reversal (once per entry). Entry kinds are contribution (+), earnings (+), payback (−), adjustment (±), reversal, and `moved_to_platform` (−). The last is bound one-to-one to a posted group-wallet assignment for the same member and takes its exact amount. This is how part of an off-platform balance becomes withdrawable cash: the money actually arrives in the group wallet first (`tests/integration/offchain.test.ts`).
