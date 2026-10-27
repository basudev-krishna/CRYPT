import type { Metadata } from 'next';
import Link from 'next/link';
import { webDb } from '@/server/db';
import { pageStaff } from '@/server/http/auth';
import { can } from '@/server/permissions';
import { adminReferralRewards, adminReferrals, referralFundBalances, referralPolicyHistory, type AdminReferral } from '@/server/queries/admin';
import { DEFAULT_TIERS, referralPolicy } from '@/server/referrals/rewards';
import { Badge, Button, Card, CardHeader, EmptyState, Input, Mono, Notice, PageHeader, Table, Td } from '@/components/ui/primitives';
import { maybeOne } from '@/server/db-core';
import { teamTree } from '@/server/referrals/network';
import { TeamTree } from '@/components/app/team-tree';
import { Money } from '@/components/ui/money';
import { ReferralRewardStatus, ReferralStageBadge } from '@/components/ui/referral-stage';
import { Stat } from '@/components/app/stat';
import { NoteAction } from '@/components/app/actions';
import { ReferralPolicyForm } from '@/components/admin/referral-policy-form';
import { dateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Referrals' };
export const dynamic = 'force-dynamic';

interface SponsorRow {
  userId: string;
  email: string;
  memberCode: string;
  total: number;
  qualified: number;
  latest: Date;
}

/** Referrals grouped by referrer, most qualified first. Input is newest first, so the first row seen is the latest. */
function bySponsor(referrals: AdminReferral[]): SponsorRow[] {
  const map = new Map<string, SponsorRow>();
  for (const r of referrals) {
    const row = map.get(r.sponsorUserId) ?? { userId: r.sponsorUserId, email: r.sponsorEmail, memberCode: r.sponsorMemberCode, total: 0, qualified: 0, latest: r.joinedAt };
    row.total += 1;
    if (r.stage === 'qualified') row.qualified += 1;
    map.set(r.sponsorUserId, row);
  }
  return [...map.values()].sort((a, b) => b.qualified - a.qualified || b.total - a.total);
}

export default async function AdminReferralsPage({ searchParams }: { searchParams: Promise<{ root?: string }> }) {
  const staff = await pageStaff();
  const db = webDb();
  const { root } = await searchParams;
  const rootCode = root?.trim().toUpperCase().slice(0, 16) ?? '';
  const rootMember = /^EW-[0-9]{6,}$/.test(rootCode)
    ? await maybeOne<{ user_id: string }>(db, 'select user_id from public.user_profiles where member_code = $1', [rootCode])
    : null;
  const tree = rootMember ? await teamTree(db, rootMember.user_id, 5) : null;
  const [referrals, rewards, funds, policy, history] = await Promise.all([
    adminReferrals(db),
    adminReferralRewards(db),
    referralFundBalances(db),
    referralPolicy(db),
    referralPolicyHistory(db),
  ]);
  const sponsors = bySponsor(referrals);
  const qualified = referrals.filter((r) => r.stage === 'qualified').length;
  const open = rewards.filter((r) => r.status === 'pending').length;
  const canReview = can(staff.roles, 'referral.review');
  const canConfigure = can(staff.roles, 'referral.configure');
  return (
    <>
      <PageHeader
        title="Referrals"
        description="Who referred whom, recorded permanently at sign-up. A referral qualifies once the account is approved and has a credited deposit. Rewards are paid only from the operator-funded referral fund, after an administrator approves each one."
      />
      <div className="grid gap-6 md:grid-cols-4">
        <Stat label="Referrals" value={referrals.length} />
        <Stat label="Qualified" value={qualified} />
        <Stat label="Rewards to review" value={open} emphasis={open > 0} />
        <Stat
          label="Program"
          value={policy?.params.enabled ? 'On' : 'Off'}
          sub={policy ? `Policy v${policy.version} · ${policy.params.reward_amount} per qualified referral` : 'Not configured yet'}
        />
      </div>

      <Card className="mt-6">
        <CardHeader title="Referral reward fund" subtitle="Operator money only. Top it up by sending USDT to the group wallet, then allocate that receipt as a referral fund top-up on the Trading & allocation page." />
        {funds.length ? (
          <Table head={['Token', 'Fund balance', 'Approved, not yet paid', 'Status']}>
            {funds.map((f) => {
              const short = BigInt(f.balance) < BigInt(f.approved_unpaid);
              return (
                <tr key={f.token_id}>
                  <Td>{f.symbol}</Td>
                  <Td><Money value={f.balance} decimals={Number(f.decimals)} /></Td>
                  <Td><Money value={f.approved_unpaid} decimals={Number(f.decimals)} /></Td>
                  <Td>{short ? <Badge tone="danger">Top-up needed</Badge> : <Badge tone="success">Covered</Badge>}</Td>
                </tr>
              );
            })}
          </Table>
        ) : (
          <EmptyState title="The fund is empty">Approved rewards wait until the fund is topped up.</EmptyState>
        )}
      </Card>

      <Card className="mt-6">
        <CardHeader title={`Rewards (${rewards.length})`} subtitle="Approve or reject each reward with a documented note. Approved rewards are paid by the worker when the fund covers them." />
        <Table
          head={['Qualified', 'Referrer', 'Referred member', 'Amount', 'Status', 'Policy', canReview ? 'Decision' : '']}
          empty={rewards.length ? null : <EmptyState title="No rewards yet">{policy?.params.enabled ? 'Rewards appear here when a referral qualifies.' : 'Switch the program on below to start recording rewards.'}</EmptyState>}
        >
          {rewards.map((r) => (
            <tr key={r.id}>
              <Td className="text-fg-muted">{dateTime(r.qualified_at)}</Td>
              <Td>
                <Link className="text-accent hover:underline" href={`/admin/users/${r.sponsor_user_id}`}>{r.sponsor_email}</Link> <Mono className="text-xs">{r.sponsor_code}</Mono>
              </Td>
              <Td>
                {r.referred_email} <Mono className="text-xs">{r.referred_code}</Mono>
              </Td>
              <Td><Money value={r.amount_base} decimals={Number(r.decimals)} symbol={r.symbol} /></Td>
              <Td>
                <ReferralRewardStatus status={r.status} />
                {r.error ? <p className="mt-1 text-xs text-loss">{r.error}</p> : null}
                {r.review_note ? <p className="mt-1 text-xs text-fg-muted">{r.review_note}</p> : null}
              </Td>
              <Td className="text-fg-muted">v{r.policy_version}</Td>
              <Td className="min-w-56">
                {canReview && r.status === 'pending' ? (
                  <NoteAction
                    url={`/api/admin/referral-rewards/${r.id}/review`}
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
        <CardHeader title="Program settings" subtitle={policy ? `Current: version ${policy.version}` : 'No policy saved yet; rewards are off.'} />
        {canConfigure ? (
          <ReferralPolicyForm
            initial={{
              enabled: policy?.params.enabled ?? false,
              reward_amount: policy?.params.reward_amount ?? '0',
              program_start: policy?.params.program_start ?? new Date().toISOString(),
              tiers: policy?.params.tiers ?? DEFAULT_TIERS,
            }}
          />
        ) : (
          <Notice tone="info">Only administrators can change the referral program.</Notice>
        )}
        {history.length ? (
          <div className="mt-6">
            <Table head={['Version', 'Saved', 'By', 'On', 'Amount', 'Reason']}>
              {history.map((h) => (
                <tr key={h.version}>
                  <Td>v{h.version}</Td>
                  <Td className="text-fg-muted">{dateTime(h.created_at)}</Td>
                  <Td className="text-xs text-fg-muted">{h.created_by}</Td>
                  <Td>{h.params.enabled ? 'Yes' : 'No'}</Td>
                  <Td>{String(h.params.reward_amount ?? '')}</Td>
                  <Td className="text-fg-muted">{h.change_note}</Td>
                </tr>
              ))}
            </Table>
          </div>
        ) : null}
      </Card>

      <Card className="mt-6">
        <CardHeader title="Team tree" subtitle="Left/right positions are set per member on their user page. Click a member to manage them." />
        <form className="mb-4 flex max-w-md gap-2">
          <label htmlFor="root" className="sr-only">Member id</label>
          <Input id="root" name="root" defaultValue={rootCode} placeholder="Show the team under EW-000123" />
          <Button type="submit" variant="secondary" className="h-9 px-3 text-xs">Show</Button>
        </form>
        {tree ? (
          <TeamTree node={tree} hrefFor={(n) => `/admin/users/${n.userId}`} />
        ) : rootCode ? (
          <EmptyState title={`No member ${rootCode}`} />
        ) : null}
      </Card>

      <Card className="mt-6">
        <CardHeader title="By referrer" />
        <Table head={['Referrer', 'Member', 'Referred', 'Qualified', 'Latest referral']} empty={sponsors.length ? null : <EmptyState title="No referrals yet" />}>
          {sponsors.map((s) => (
            <tr key={s.userId}>
              <Td><Link className="text-accent hover:underline" href={`/admin/users/${s.userId}`}>{s.email}</Link></Td>
              <Td><Mono>{s.memberCode}</Mono></Td>
              <Td>{s.total}</Td>
              <Td>{s.qualified}</Td>
              <Td className="text-fg-muted">{dateTime(s.latest)}</Td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card className="mt-6">
        <CardHeader title={`All referrals (${referrals.length})`} />
        <Table head={['Joined', 'Member', 'Referred by', 'Status', 'First deposit credited']} empty={referrals.length ? null : <EmptyState title="No referrals yet" />}>
          {referrals.map((r) => (
            <tr key={r.userId}>
              <Td className="text-fg-muted">{dateTime(r.joinedAt)}</Td>
              <Td>
                <Link className="text-accent hover:underline" href={`/admin/users/${r.userId}`}>{r.email}</Link> <Mono className="text-xs">{r.memberCode}</Mono>
              </Td>
              <Td><Mono>{r.sponsorMemberCode}</Mono></Td>
              <Td><ReferralStageBadge stage={r.stage} /></Td>
              <Td className="text-fg-muted">{r.firstCreditedAt ? dateTime(r.firstCreditedAt) : '—'}</Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
