/**
 * Automatic enrolment of member deposits into the active automatic plan
 * (see docs/daily-returns.md). Runs in the worker before accrual, so existing
 * deposits are enrolled when the plan is activated and new ones as they land.
 *
 *   on-platform: each user_cash credit from a deposit (deposit_credit, or an
 *     admin assignment/distribution of a group-wallet receipt) that is not
 *     reversed and not money moved on-platform from an offline contribution
 *     (that one is already enrolled as offline);
 *   offline: each off-platform contribution of a linked member, not reversed.
 *
 * Each source is enrolled once (unique source columns). An on-platform
 * enrolment never exceeds the member's available cash less what is already
 * waiting to be committed, so a deposit already withdrawn is not enrolled; one
 * below the plan minimum is left alone. The subscription itself is opened by
 * openSubscription under the balance lock, as for a member's own request.
 */
import { many, maybeOne, one, type Db } from '../db-core';
import { parseBase } from '@/lib/money';
import { ensureAccount, cachedBalance } from '../ledger/ledger';
import { microToBase } from '../offchain/holdings';
import { getToken } from '../chains/registry';
import { notify, recordAudit, type Actor } from '../ops';

interface AutoPlan {
  id: string;
  token_id: number;
  min_principal_base: string;
}

async function autoPlans(db: Db): Promise<AutoPlan[]> {
  return many<AutoPlan>(db, "select id, token_id, min_principal_base::text from public.return_plans where auto_enroll and status = 'active' order by activated_at");
}

const key = (kind: string, id: string) => `auto-${kind}-${id.padStart(12, '0')}`;

export async function enrollDeposits(db: Db, actor: Actor, limit = 200): Promise<number> {
  let enrolled = 0;
  for (const plan of await autoPlans(db)) {
    const tokenId = Number(plan.token_id);
    const min = parseBase(plan.min_principal_base);

    const lines = await many<{ line_id: string; user_id: string; amount: string; posted_at: Date }>(
      db,
      `select l.id as line_id, a.user_id, l.amount::text as amount, e.posted_at
         from public.journal_lines l
         join public.ledger_accounts a on a.id = l.account_id and a.purpose = 'user_cash'
         join public.journal_entries e on e.id = l.entry_id
         join public.user_profiles u on u.user_id = a.user_id and u.account_status = 'active'
        where l.direction = 'C' and l.token_id = $1 and e.event_type in ('deposit_credit', 'deposit_allocated')
          and not exists (select 1 from public.journal_entries r where r.reverses_entry_id = e.id)
          and not exists (select 1 from public.plan_subscriptions s where s.source_line_id = l.id)
          and not (e.source_type = 'allocation'
                   and exists (select 1 from public.offchain_entries o where o.allocation_id::text = e.source_id and o.kind = 'moved_to_platform'))
        order by e.posted_at, l.id limit $2`,
      [tokenId, limit],
    );
    for (const l of lines) {
      const cash = await cachedBalance(db, await ensureAccount(db, 'user_cash', tokenId, { userId: l.user_id }));
      const waiting = await one<{ s: string }>(
        db,
        "select coalesce(sum(principal_base), 0)::text as s from public.plan_subscriptions where user_id = $1 and token_id = $2 and funding = 'platform' and status = 'pending'",
        [l.user_id, tokenId],
      );
      const free = cash - parseBase(waiting.s);
      const amount = parseBase(l.amount) < free ? parseBase(l.amount) : free;
      if (amount < min) continue;
      const row = await maybeOne<{ id: string }>(
        db,
        `insert into public.plan_subscriptions (user_id, plan_id, token_id, principal_base, client_key, funding, source_line_id, principal_received_at)
         values ($1, $2, $3, $4, $5, 'platform', $6, $7) on conflict do nothing returning id`,
        [l.user_id, plan.id, tokenId, amount.toString(), key('line', String(l.line_id)), l.line_id, l.posted_at],
      );
      if (!row) continue;
      enrolled++;
      await recordAudit(db, actor, 'returns.deposit_enrolled', { type: 'plan_subscription', id: row.id }, { sourceLineId: l.line_id, principalBase: amount.toString() });
    }

    const token = await getToken(db, tokenId);
    const contributions = await many<{ id: string; user_id: string; amount_micro: string; occurred_on: string; created_by: string; reason: string }>(
      db,
      `select e.id, h.user_id, e.amount_micro::text, to_char(e.occurred_on, 'YYYY-MM-DD') as occurred_on, e.created_by, e.reason
         from public.offchain_entries e
         join public.offchain_holders h on h.id = e.holder_id
         join public.user_profiles u on u.user_id = h.user_id and u.account_status = 'active'
        where e.kind = 'contribution'
          and not exists (select 1 from public.offchain_entries r where r.reverses_entry_id = e.id)
          and not exists (select 1 from public.plan_subscriptions s where s.source_offchain_entry_id = e.id)
        order by e.id limit $1`,
      [limit],
    );
    for (const c of contributions) {
      const amount = microToBase(parseBase(c.amount_micro), token.decimals);
      if (amount < min) continue;
      const row = await maybeOne<{ id: string }>(
        db,
        `insert into public.plan_subscriptions (user_id, plan_id, token_id, principal_base, client_key, funding, offline_reference, recorded_by, source_offchain_entry_id, principal_received_at)
         values ($1, $2, $3, $4, $5, 'offline', $6, $7, $8, $9) on conflict do nothing returning id`,
        [c.user_id, plan.id, tokenId, amount.toString(), key('offchain', String(c.id)), `Off-platform contribution #${c.id}: ${c.reason}`.slice(0, 500), c.created_by, c.id, `${c.occurred_on}T00:00:00Z`],
      );
      if (!row) continue;
      enrolled++;
      await recordAudit(db, actor, 'returns.deposit_enrolled', { type: 'plan_subscription', id: row.id }, { sourceOffchainEntryId: c.id, principalBase: amount.toString() });
      await notify(db, { userId: c.user_id, kind: 'plan_enrolled', payload: { subscriptionId: row.id, principalBase: amount.toString(), offline: true }, dedupeKey: `plan_enrolled:${row.id}` });
    }
  }
  return enrolled;
}
