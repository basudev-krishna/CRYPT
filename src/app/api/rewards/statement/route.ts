import { NextResponse } from 'next/server';
import { requireUser } from '@/server/http/auth';
import { route } from '@/server/http/api';
import { webDb } from '@/server/db';
import { formatUnits } from '@/lib/money';
import { listProgramRewards } from '@/server/referrals/program';
import { listReferralRewards } from '@/server/queries/user';

/** A CSV cell, quoted, with spreadsheet formula prefixes neutralised. */
const cell = (v: string | number | null | undefined) => {
  const s = String(v ?? '');
  return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};

/** The signed-in member's reward statement: referral, matching and rank rewards with their status and ledger reference. */
export const GET = route(
  async () => {
    const user = await requireUser();
    const db = webDb();
    const [program, referral] = await Promise.all([listProgramRewards(db, user.id), listReferralRewards(db, user.id)]);
    const rows: (string | number | null)[][] = [
      ['recorded', 'kind', 'detail', 'amount', 'token', 'status', 'paid_at', 'ledger_entry'],
      ...program.map((r) => [
        r.created_at.toISOString(),
        r.kind,
        r.kind === 'matching' ? `level ${r.level} of ${r.source_code}` : `rank ${r.rank_code}`,
        formatUnits(BigInt(r.amount_base), Number(r.decimals)),
        r.symbol,
        r.status,
        r.posted_at?.toISOString() ?? null,
        r.entry_id,
      ]),
      ...referral.map((r) => [
        r.qualifiedAt.toISOString(),
        'referral',
        `referred ${r.referredMemberCode}`,
        formatUnits(BigInt(r.amountBase), r.decimals),
        r.symbol,
        r.status,
        r.postedAt?.toISOString() ?? null,
        null,
      ]),
    ];
    return new NextResponse(rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n', {
      headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="elitewhale-rewards.csv"', 'cache-control': 'no-store' },
    });
  },
  { limit: 10, windowSeconds: 60 },
);
