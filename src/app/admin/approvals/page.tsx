import type { Metadata } from 'next';
import { webDb } from '@/server/db';
import { pageStaff } from '@/server/http/auth';
import { can } from '@/server/permissions';
import { adminSignupQueue, signupStats } from '@/server/queries/admin';
import { Card, CardHeader, Notice, PageHeader } from '@/components/ui/primitives';
import { Stat } from '@/components/app/stat';
import { ApprovalQueue } from '@/components/admin/approval-queue';
import { SignupBars } from '@/components/charts/value-chart';
import { dateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Sign-up approvals' };
export const dynamic = 'force-dynamic';

export default async function AdminApprovalsPage() {
  const staff = await pageStaff();
  const db = webDb();
  const [rows, stats] = await Promise.all([adminSignupQueue(db), signupStats(db)]);
  const canDecide = can(staff.roles, 'user.approve');
  return (
    <>
      <PageHeader
        title="Sign-up approvals"
        description="Every new account waits here until an administrator approves it. Pending accounts can sign in but cannot see or do anything else. Each decision needs a note and is recorded in the audit log."
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Waiting for approval" value={stats.pending} emphasis={stats.pending > 0} sub={stats.oldestPending ? `Oldest since ${dateTime(stats.oldestPending)}` : 'Queue is clear'} />
        <Stat label="Approved (7 days)" value={stats.approved7d} />
        <Stat label="Rejected (7 days)" value={stats.rejected7d} />
      </div>
      <Card className="mt-6">
        <CardHeader title="New sign-ups" subtitle="Accounts created per day, last 14 days (UTC)" />
        <SignupBars data={stats.daily} />
      </Card>
      <Card className="mt-6">
        <CardHeader title="Approval queue" />
        {!canDecide ? (
          <div className="mb-4">
            <Notice tone="info">Only administrators can approve or reject sign-ups. You can view the queue.</Notice>
          </div>
        ) : null}
        <ApprovalQueue rows={rows} canDecide={canDecide} />
      </Card>
    </>
  );
}
