import type { Metadata } from 'next';
import { pageUser } from '@/server/http/auth';
import { webDb } from '@/server/db';
import { getMembership, listReferralRewards } from '@/server/queries/user';
import { DEFAULT_TIERS, referralPolicy, referralTier } from '@/server/referrals/rewards';
import { teamTree } from '@/server/referrals/network';
import { TeamTree } from '@/components/app/team-tree';
import { Badge, Card, CardHeader, EmptyState, Mono, Notice, PageHeader, Table, Td } from '@/components/ui/primitives';
import { Money } from '@/components/ui/money';
import { ReferralRewardStatus, ReferralStageBadge } from '@/components/ui/referral-stage';
import { Stat } from '@/components/app/stat';
import { ReferralLink } from '@/components/app/referral-link';
import { dateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Referrals' };

export default async function ReferralsPage() {
  const user = await pageUser();
  const db = webDb();
  const [membership, rewards, policy, tree] = await Promise.all([getMembership(db, user.id), listReferralRewards(db, user.id), referralPolicy(db), teamTree(db, user.id, 4)]);
  if (!membership) return <PageHeader title="Referrals" />;
  const referred = membership.sponsored;
  const qualified = referred.filter((r) => r.stage === 'qualified').length;
  const tiers = policy?.params.tiers ?? DEFAULT_TIERS;
  const tier = referralTier(qualified, tiers);
  const program = policy?.params.enabled ? policy.params : null;
  return (
    <>
      <PageHeader
        title="Referrals"
        description="Invite people you know. Anyone who signs up with your link or referral id is recorded as your referral, permanently."
      />
      <div className="grid gap-6 md:grid-cols-4">
        <Stat
          label="Your referral id"
          value={<Mono className="text-xl">{membership.memberCode}</Mono>}
          sub={membership.sponsorMemberCode ? `You were referred by ${membership.sponsorMemberCode}` : undefined}
        />
        <Stat
          label="Your tier"
          value={tier.current?.label ?? '—'}
          emphasis={tier.current !== null}
          sub={tier.next ? `${tier.remaining} more qualified for ${tier.next.label}` : 'Top tier reached'}
        />
        <Stat label="People referred" value={referred.length} />
        <Stat label="Qualified" value={qualified} sub="Approved and made a first deposit" />
      </div>

      <Card className="mt-6">
        <CardHeader title="Your referral link" subtitle="Share it, or ask them to enter your referral id when signing up." />
        <ReferralLink memberCode={membership.memberCode} />
        <div className="mt-4">
          <Notice tone="info">
            {program
              ? `Each qualified referral earns a ${program.reward_amount} USDT reward, paid by EliteWhale from its own referral fund after an administrator approves it. Rewards are credited to your available balance once paid; pending rewards cannot be withdrawn.`
              : 'Referrals are recorded now. Rewards for qualified referrals are not active at the moment.'}
          </Notice>
        </div>
      </Card>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title="Tiers" subtitle="Recognition by qualified referrals." />
          <div className="flex flex-wrap gap-2">
            {tiers.map((t) => (
              <Badge key={t.label} tone={qualified >= t.min_qualified ? 'success' : 'neutral'} title={`${t.min_qualified} qualified referrals`}>
                {t.label} · {t.min_qualified}
              </Badge>
            ))}
          </div>
        </Card>
        <Card>
          <CardHeader title={`Your rewards (${rewards.length})`} />
          <Table head={['Referral', 'Amount', 'Status', 'Paid']} empty={rewards.length ? null : <EmptyState title="No rewards yet" />}>
            {rewards.map((r) => (
              <tr key={r.id}>
                <Td><Mono>{r.referredMemberCode}</Mono></Td>
                <Td><Money value={r.amountBase} decimals={r.decimals} symbol={r.symbol} /></Td>
                <Td><ReferralRewardStatus status={r.status} /></Td>
                <Td className="text-fg-muted">{r.postedAt ? dateTime(r.postedAt) : '—'}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader
          title="Your team"
          subtitle={tree ? `Left team ${tree.leftCount} · Right team ${tree.rightCount}. Positions are set by the administrator.` : undefined}
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
