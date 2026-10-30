import type { Metadata } from 'next';
import { pageUser } from '@/server/http/auth';
import { webDb } from '@/server/db';
import { memberProgramOverview } from '@/server/referrals/program';
import { getDashboard, getRewardIncome } from '@/server/queries/user';
import { memberHolding, MICRO_DECIMALS, microToBase } from '@/server/offchain/holdings';
import { usdFixed } from '@/server/referrals/program-math';
import { Badge, Card, CardHeader, EmptyState, Mono, Table, Td } from '@/components/ui/primitives';
import { Money } from '@/components/ui/money';
import { ReferralRewardStatus } from '@/components/ui/referral-stage';
import { Stat } from '@/components/app/stat';
import { pct, Progress, RewardsHeader, share, Usd } from '@/components/app/rewards-parts';
import { dateTime } from '@/lib/format';
import { ClaimRewardButton } from '@/components/app/actions';

export const metadata: Metadata = { title: 'Matching bonus' };

export default async function MatchingPage() {
  const user = await pageUser();
  const db = webDb();
  const [o, d, holding] = await Promise.all([memberProgramOverview(db, user.id), getDashboard(db, user.id), memberHolding(db, user.id)]);
  const income = d.token ? await getRewardIncome(db, user.id, d.token.id) : 0n;
  const dec = d.token?.decimals ?? 6;
  const sym = d.token?.symbol ?? 'USDT';
  const { program, volumes: v } = o;
  const held = holding && holding.balance > 0n ? microToBase(holding.balance, dec) : 0n;
  const rewards = o.rewards.filter((r) => r.kind === 'matching');
  // Matching bonuses the administrator added by hand (held with them, not withdrawable).
  const manual = (holding?.entries ?? []).filter((e) => e.category === 'matching_bonus');
  const manualTotal = manual.filter((e) => !e.reversed).reduce((s, e) => s + e.amountMicro, 0n);
  return (
    <>
      <RewardsHeader title="Matching bonus" />

      <div className="grid gap-6 md:grid-cols-3">
        <Stat label="Left team" value={v.leftCount} sub={<>Volume <Usd value={v.left} /></>} />
        <Stat label="Right team" value={v.rightCount} sub={<>Volume <Usd value={v.right} /></>} />
        <Stat label="Matching bonus added for you" value={<Money value={manualTotal} decimals={MICRO_DECIMALS} symbol="USDT" />} sub="Held with the administrator" />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader
            title="Minimum matching amount"
            subtitle="A threshold on each side's operator-funded volume before matching can pay you. It is not a deposit requirement and not a guarantee of payment."
          />
          <dl className="mb-5 grid gap-3 sm:grid-cols-3">
            {(
              [
                ['Total balance', d.totalAccountValue + held, held > 0n ? 'Includes money held by the administrator' : 'Your whole account value'],
                ['Total income', income, 'All rewards paid to you'],
                ['Available to withdraw', d.available, 'Ready to withdraw now'],
              ] as const
            ).map(([label, amount, hint]) => (
              <div key={label} className="rounded-xl bg-surface-3/60 p-3 ring-1 ring-black/5">
                <dt className="text-xs text-fg-muted">{label}</dt>
                <dd className="mt-1 text-base font-semibold">
                  <Money value={amount} decimals={dec} symbol={sym} />
                </dd>
                <dd className="mt-0.5 text-[11px] text-fg-subtle">{hint}</dd>
              </div>
            ))}
          </dl>
          {(['left', 'right'] as const).map((side) => {
            const have = v[side];
            const need = side === 'left' ? program.matching.min_left : program.matching.min_right;
            return (
              <div key={side} className="mb-4">
                <div className="mb-1 flex justify-between text-sm">
                  <span className="capitalize">{side} team</span>
                  <span className="text-fg-muted">
                    <Usd value={have} /> of <Usd value={usdFixed(need)} />
                  </span>
                </div>
                <Progress bps={share(have, need)} label={`${side} team minimum`} />
              </div>
            );
          })}
          {o.eligibility.eligible ? (
            <Badge tone="success">Eligible for matching</Badge>
          ) : (
            <div>
              <Badge tone="warn">Not eligible yet</Badge>
              <ul className="mt-2 list-disc pl-5 text-xs text-fg-muted">
                {o.eligibility.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Matching levels"
            subtitle={`A share of operator-funded earnings by your ${program.matching.tree === 'sponsor' ? 'referral line' : 'team line'}, down ${program.matching.levels.length} levels.${program.matching.min_rank ? ` Requires rank ${program.matching.min_rank}.` : ''}`}
          />
          <Table head={['Level', 'Rate']}>
            {program.matching.levels.map((l) => (
              <tr key={l.level}>
                <Td>Level {l.level}</Td>
                <Td>{pct(l.rate_bps)}</Td>
              </tr>
            ))}
          </Table>
          <p className="mt-3 text-xs text-fg-muted">
            Status: {program.matching.enabled ? <Badge tone="success">Paying</Badge> : <Badge tone="neutral">Information only</Badge>}
          </p>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader title={`Matching bonus added by the administrator (${manual.length})`} subtitle="Part of the balance you hold with the administrator; see Off-platform for the full record." />
        <Table head={['Date', 'Amount', 'Reason']} empty={manual.length ? null : <EmptyState title="None yet" />}>
          {manual.map((e) => (
            <tr key={e.id}>
              <Td className="text-fg-muted">{e.occurredOn}</Td>
              <Td><Money value={e.amountMicro} decimals={MICRO_DECIMALS} symbol="USDT" /></Td>
              <Td>
                {e.reason}
                {e.reversed ? <span className="block text-xs text-loss">Reversed</span> : null}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card className="mt-6">
        <CardHeader
          title={`Matching rewards (${rewards.length})`}
          subtitle="Calculated by the program from your team's operator-funded earnings and shown here first. Claim each one to have it paid to your available balance after approval."
        />
        <Table head={['Recorded', 'Level', 'From', 'Amount', 'Status', 'Paid', '']} empty={rewards.length ? null : <EmptyState title="No matching rewards yet" />}>
          {rewards.map((r) => (
            <tr key={r.id}>
              <Td className="text-fg-muted">{dateTime(r.created_at)}</Td>
              <Td>Level {r.level} ({pct(r.rate_bps ?? 0)})</Td>
              <Td>{r.source_code ? <Mono>{r.source_code}</Mono> : '—'}</Td>
              <Td><Money value={r.amount_base} decimals={Number(r.decimals)} symbol={r.symbol} /></Td>
              <Td><ReferralRewardStatus status={r.status} claimed={Boolean(r.claimed_at)} /></Td>
              <Td className="text-fg-muted">{r.posted_at ? dateTime(r.posted_at) : '—'}</Td>
              <Td>{!r.claimed_at && (r.status === 'pending' || r.status === 'approved') ? <ClaimRewardButton kind="program" rewardId={r.id} /> : null}</Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
