import type { Metadata } from 'next';
import Link from 'next/link';
import { webDb } from '@/server/db';
import { pageStaff } from '@/server/http/auth';
import { can } from '@/server/permissions';
import { many } from '@/server/db-core';
import { listActiveTokens } from '@/server/queries/user';
import { adminProgramRewards, effectiveProgram, rewardTreasury } from '@/server/referrals/program';
import { Badge, Card, CardHeader, EmptyState, Mono, Notice, PageHeader, Table, Td } from '@/components/ui/primitives';
import { Money } from '@/components/ui/money';
import { ReferralRewardStatus } from '@/components/ui/referral-stage';
import { Stat } from '@/components/app/stat';
import { NoteAction } from '@/components/app/actions';
import { ProgramPolicyForm } from '@/components/admin/program-policy-form';
import { dateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Reward treasury' };
export const dynamic = 'force-dynamic';

const FLOW_LABELS: Record<string, string> = {
  deposit_allocated: 'Operator funding (group-wallet receipts)',
  referral_reward: 'Referral rewards paid',
  referral_bonus: 'Bonuses for work paid / reversed',
  income_correction: 'Income corrections returned to the pool',
  program_reward: 'Matching and rank rewards paid',
  reversal: 'Ledger reversals',
};

export default async function RewardTreasuryPage() {
  const staff = await pageStaff();
  const db = webDb();
  const [treasury, rewards, program, tokens, history] = await Promise.all([
    rewardTreasury(db),
    adminProgramRewards(db),
    effectiveProgram(db),
    listActiveTokens(db),
    many<{ version: number; created_at: Date; created_by: string; change_note: string; params: { matching?: { enabled?: boolean }; ranks?: { rewards_enabled?: boolean } } }>(
      db,
      "select version, created_at, created_by, change_note, params from public.policy_versions where kind = 'rewards_program' order by version desc limit 20",
    ),
  ]);
  const canReview = can(staff.roles, 'referral.review');
  const canConfigure = can(staff.roles, 'referral.configure');
  const p = program.params;
  const pending = rewards.filter((r) => r.status === 'pending').length;
  const held = rewards.filter((r) => r.status === 'approved' && r.error).length;
  return (
    <>
      <PageHeader
        title="Reward treasury"
        description="The operator reward pool pays referral rewards, bonuses for work, matching bonuses and rank rewards. It holds only operator money received in the group wallet and allocated as a referral fund top-up; members' deposits never enter it, and it can never go negative."
      />
      <div className="grid gap-6 md:grid-cols-4">
        <Stat label="Rewards to review" value={pending} emphasis={pending > 0} />
        <Stat label="Approved, held" value={held} sub="Waiting for funding or an active account" />
        <Stat label="Matching payouts" value={p.matching.enabled ? 'On' : 'Off'} sub={program.version ? `Policy v${program.version}` : 'Not configured: provisional defaults'} />
        <Stat label="Rank rewards" value={p.ranks.rewards_enabled ? 'On' : 'Off'} sub={`Sign-up placement: ${p.placement_mode === 'outer' ? 'down the chosen side' : 'directly under sponsor only'}`} />
      </div>

      <Card className="mt-6">
        <CardHeader
          title="Pool by token"
          subtitle={
            <>
              To fund the pool, send operator USDT to the group wallet, then allocate that receipt as a referral fund top-up on{' '}
              <Link className="text-accent hover:underline" href="/admin/trading">Trading &amp; allocation</Link>. The on-chain match is checked by{' '}
              <Link className="text-accent hover:underline" href="/admin/treasury">Treasury &amp; reconciliation</Link>.
            </>
          }
        />
        {treasury.length ? (
          <div className="space-y-6">
            {treasury.map((t) => (
              <div key={t.tokenId}>
                <div className="mb-3 grid gap-3 sm:grid-cols-4">
                  <div>
                    <p className="text-xs uppercase tracking-wider text-fg-muted">Pool balance</p>
                    <p className="text-lg"><Money value={t.position.balance} decimals={t.decimals} symbol={t.symbol} /></p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-wider text-fg-muted">Committed (approved, unpaid)</p>
                    <p className="text-lg"><Money value={t.position.committed} decimals={t.decimals} symbol={t.symbol} /></p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-wider text-fg-muted">Available to approve</p>
                    <p className="text-lg"><Money value={t.position.available} decimals={t.decimals} symbol={t.symbol} colored /></p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-wider text-fg-muted">Ledger check</p>
                    <p className="mt-1">{t.reconciled ? <Badge tone="success">Balance matches its entries</Badge> : <Badge tone="danger">Mismatch: investigate</Badge>}</p>
                  </div>
                </div>
                <Table head={['Flow', 'Into pool', 'Out of pool', 'Entries']}>
                  {t.flows.map((f) => (
                    <tr key={f.event_type}>
                      <Td>{FLOW_LABELS[f.event_type] ?? f.event_type}</Td>
                      <Td><Money value={f.inflow} decimals={t.decimals} /></Td>
                      <Td><Money value={f.outflow} decimals={t.decimals} /></Td>
                      <Td>{f.entries}</Td>
                    </tr>
                  ))}
                </Table>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="The pool has never been funded">Rewards can be recorded, but none can be approved until the pool covers them.</EmptyState>
        )}
      </Card>

      <Card className="mt-6">
        <CardHeader
          title={`Matching and rank rewards (${rewards.length})`}
          subtitle="Approving reserves the amount: it is refused unless the pool covers it on top of everything already approved. Approved rewards are paid by the worker."
        />
        <Table
          head={['Recorded', 'Member', 'Reward', 'Calculation', 'Amount', 'Status', 'Policy', canReview ? 'Decision' : '']}
          empty={rewards.length ? null : <EmptyState title="No rewards yet">{p.matching.enabled || p.ranks.rewards_enabled ? 'Rewards appear here as they become due.' : 'Matching and rank payouts are off.'}</EmptyState>}
        >
          {rewards.map((r) => (
            <tr key={r.id}>
              <Td className="text-fg-muted">{dateTime(r.created_at)}</Td>
              <Td>
                <Link className="text-accent hover:underline" href={`/admin/users/${r.beneficiary_user_id}`}>{r.beneficiary_email}</Link> <Mono className="text-xs">{r.beneficiary_code}</Mono>
              </Td>
              <Td>{r.kind === 'matching' ? `Matching L${r.level}` : `Rank ${r.rank_code}`}</Td>
              <Td className="text-xs text-fg-muted">
                {r.kind === 'matching' && r.base_amount ? (
                  <>
                    {(r.rate_bps ?? 0) / 100}% of <Money value={r.base_amount} decimals={Number(r.decimals)} /> earned by <Mono>{r.source_code}</Mono>
                  </>
                ) : (
                  'Listed rank bonus'
                )}
              </Td>
              <Td><Money value={r.amount_base} decimals={Number(r.decimals)} symbol={r.symbol} /></Td>
              <Td>
                <ReferralRewardStatus status={r.status} />
                {r.status === 'pending' || r.status === 'approved' ? (
                  <p className="mt-1 text-xs text-fg-muted">{r.claimed_at ? 'Claimed by the member' : 'Not claimed yet: paid only after the member claims it'}</p>
                ) : null}
                {r.error ? <p className="mt-1 text-xs text-loss">{r.error}</p> : null}
                {r.review_note ? <p className="mt-1 text-xs text-fg-muted">{r.review_note}</p> : null}
              </Td>
              <Td className="text-fg-muted">v{r.policy_version}</Td>
              <Td className="min-w-56">
                {canReview && r.status === 'pending' ? (
                  <NoteAction
                    url={`/api/admin/program-rewards/${r.id}/review`}
                    options={[
                      { field: 'decision', value: 'approve', label: 'Approve' },
                      { field: 'decision', value: 'reject', label: 'Reject' },
                    ]}
                    noteLabel="Documented reason"
                  />
                ) : null}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card className="mt-6">
        <CardHeader title="Program settings" subtitle={program.version ? `Current: version ${program.version}` : 'No policy saved yet: provisional defaults, every payout off.'} />
        <div className="mb-4">
          <Notice tone="warn" title="Before switching payouts on">
            The rates, targets and bonuses are provisional. Have the compensation plan reviewed for the countries your members live in, and fund the pool first. Volumes count operator-funded earnings only, never deposits.
          </Notice>
        </div>
        {canConfigure ? (
          <ProgramPolicyForm initial={p} tokens={tokens.map((t) => ({ id: t.id, symbol: t.symbol, network: t.networkName }))} />
        ) : (
          <Notice tone="info">Only administrators can change the program.</Notice>
        )}
        {history.length ? (
          <div className="mt-6">
            <Table head={['Version', 'Saved', 'By', 'Matching', 'Rank rewards', 'Reason']}>
              {history.map((h) => (
                <tr key={h.version}>
                  <Td>v{h.version}</Td>
                  <Td className="text-fg-muted">{dateTime(h.created_at)}</Td>
                  <Td className="text-xs text-fg-muted">{h.created_by}</Td>
                  <Td>{h.params.matching?.enabled ? 'On' : 'Off'}</Td>
                  <Td>{h.params.ranks?.rewards_enabled ? 'On' : 'Off'}</Td>
                  <Td className="text-fg-muted">{h.change_note}</Td>
                </tr>
              ))}
            </Table>
          </div>
        ) : null}
      </Card>
    </>
  );
}
