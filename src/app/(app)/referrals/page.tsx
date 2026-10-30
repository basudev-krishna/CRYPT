import type { Metadata } from 'next';
import Link from 'next/link';
import { pageUser } from '@/server/http/auth';
import { webDb } from '@/server/db';
import { getMembership } from '@/server/queries/user';
import { describeReferralReward, referralCommissions, referralPolicy } from '@/server/referrals/rewards';
import { teamTree } from '@/server/referrals/network';
import { TeamTree } from '@/components/app/team-tree';
import { Card, CardHeader, EmptyState, Mono, Notice, PageHeader, Table, Td } from '@/components/ui/primitives';
import { Money } from '@/components/ui/money';
import { ReferralRewardStatus, ReferralStageBadge } from '@/components/ui/referral-stage';
import { Stat } from '@/components/app/stat';
import { ReferralLink } from '@/components/app/referral-link';
import { ClaimRewardButton } from '@/components/app/actions';
import { dateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Referrals' };

export default async function ReferralsPage() {
  const user = await pageUser();
  const db = webDb();
  const [membership, commissions, policy, tree] = await Promise.all([getMembership(db, user.id), referralCommissions(db, user.id), referralPolicy(db), teamTree(db, user.id, 4)]);
  if (!membership) return <PageHeader title="Referrals" />;
  const referred = membership.sponsored;
  const program = policy?.params.enabled ? policy.params : null;
  // Totals per token symbol would be overkill here: the group runs on one stablecoin.
  const due = commissions.filter((c) => c.commissionBase !== null && ['earned', 'pending', 'approved', 'posted'].includes(c.status));
  const sum = (list: typeof due) => list.reduce((s, c) => s + (c.commissionBase ?? 0n), 0n);
  const dec = due[0]?.decimals ?? 18;
  const sym = due[0]?.symbol ?? 'USDT';
  return (
    <>
      <PageHeader
        title="Referrals"
        description="Invite people you know. Anyone who signs up with your link or referral id is recorded as your referral, permanently."
      />
      <div className="grid gap-6 md:grid-cols-2">
        <Stat
          label="Your referral id"
          value={<Mono className="text-xl">{membership.memberCode}</Mono>}
          sub={membership.sponsorMemberCode ? `You were referred by ${membership.sponsorMemberCode}` : undefined}
        />
        <Stat label="People referred" value={referred.length} />
      </div>

      <Card className="mt-6">
        <CardHeader title="Your referral link" subtitle="Share it, or ask them to enter your referral id when signing up." />
        <ReferralLink memberCode={membership.memberCode} />
        <div className="mt-4">
          <Notice tone="info">
            {program
              ? `Each qualified referral earns you ${describeReferralReward(program)}, paid by EliteWhale from its own referral fund after an administrator approves it. Rewards are credited to your available balance once paid; pending rewards cannot be withdrawn.`
              : 'Referrals are recorded now. Rewards for qualified referrals are not active at the moment.'}
          </Notice>
        </div>
      </Card>

      <div className="mt-6 grid gap-6 md:grid-cols-3">
        <Stat label="Commission earned" value={<Money value={sum(due)} decimals={dec} symbol={sym} />} sub="All commissions earned so far" />
        <Stat label="Awaiting approval or payment" value={<Money value={sum(due.filter((c) => c.status !== 'posted'))} decimals={dec} symbol={sym} />} sub="Not withdrawable yet" />
        <Stat label="Paid to you" value={<Money value={sum(due.filter((c) => c.status === 'posted'))} decimals={dec} symbol={sym} />} sub="In your available balance" />
      </div>

      <Card className="mt-6">
        <CardHeader
          title={`Your commissions (${commissions.length})`}
          subtitle={program ? `${describeReferralReward(program)} for each person you referred, shown as soon as it is earned. Claim it to have it paid to your available balance after approval.` : 'Referral commissions are not switched on at the moment.'}
        />
        <Table
          head={['Referral', 'Joined', 'First deposit', 'Commission', 'Status', 'Paid', '']}
          empty={commissions.length ? null : <EmptyState title="No referrals yet">Share your link to get started.</EmptyState>}
        >
          {commissions.map((c) => (
            <tr key={c.memberCode}>
              <Td><Mono>{c.memberCode}</Mono></Td>
              <Td className="text-fg-muted">{dateTime(c.joinedAt)}</Td>
              <Td>{c.firstDeposit ? <Money value={c.firstDeposit.amountBase} decimals={c.firstDeposit.decimals} symbol={c.firstDeposit.symbol} /> : <span className="text-fg-muted">—</span>}</Td>
              <Td>{c.commissionBase !== null ? <Money value={c.commissionBase} decimals={c.decimals} symbol={c.symbol} /> : <span className="text-fg-muted">—</span>}</Td>
              <Td>
                <ReferralRewardStatus status={c.status} claimed={c.rewardId ? Boolean(c.claimedAt) : undefined} />
                {c.status === 'earned' ? <p className="mt-1 text-xs text-fg-subtle">Can be claimed in a moment, once it is recorded.</p> : null}
              </Td>
              <Td className="text-fg-muted">{c.postedAt ? dateTime(c.postedAt) : '—'}</Td>
              <Td>{c.rewardId && !c.claimedAt && (c.status === 'pending' || c.status === 'approved') ? <ClaimRewardButton kind="referral" rewardId={c.rewardId} /> : null}</Td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card className="mt-6">
        <CardHeader
          title="Your team"
          subtitle={
            tree
              ? `Left team ${tree.leftCount} · Right team ${tree.rightCount}. Members who join with your referral id choose their side; only an administrator can move a position.`
              : undefined
          }
          action={<Link className="text-xs font-medium text-accent hover:underline" href="/rewards/matching">Matching bonus →</Link>}
        />
        {tree && (tree.left || tree.right) ? <TeamTree node={tree} /> : <EmptyState title="No team members placed yet" />}
      </Card>

      <Card className="mt-6">
        <CardHeader title={`People you referred (${referred.length})`} />
        <Table head={['Member', 'Joined', 'Status']} empty={referred.length ? null : <EmptyState title="No referrals yet">Share your link to get started.</EmptyState>}>
          {referred.map((r) => (
            <tr key={r.memberCode}>
              <Td><Mono>{r.memberCode}</Mono></Td>
              <Td className="text-fg-muted">{dateTime(r.joinedAt)}</Td>
              <Td><ReferralStageBadge stage={r.stage} /></Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
