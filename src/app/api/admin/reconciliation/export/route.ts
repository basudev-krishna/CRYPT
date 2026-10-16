import { NextResponse } from 'next/server';
import { requestActor, requirePermission } from '@/server/http/auth';
import { route } from '@/server/http/api';
import { webDb } from '@/server/db';
import { many } from '@/server/db-core';
import { recordAudit } from '@/server/ops';

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  // Neutralize spreadsheet formula injection.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

export const GET = route(async (req) => {
  const staff = await requirePermission('report.export');
  const runId = req.nextUrl.searchParams.get('runId');
  const rows = await many<Record<string, unknown>>(
    webDb(),
    `select r.id as run_id, r.started_at, r.status, n.code as network, t.symbol, s.onchain_balance_base, s.ledger_treasury_base,
            s.virtual_venue_net_base, s.in_flight_out_base, s.customer_liabilities_base, s.pool_assets_base, s.discrepancy_base
       from public.reconciliation_runs r join public.treasury_snapshots s on s.reconciliation_run_id = r.id
       join public.supported_networks n on n.id = s.network_id join public.supported_tokens t on t.id = s.token_id
      where ($1::bigint is null or r.id = $1) order by r.started_at desc limit 5000`,
    [runId && /^\d+$/.test(runId) ? runId : null],
  );
  await recordAudit(webDb(), await requestActor(staff, 'staff'), 'report.export.reconciliation', undefined, { runId, rows: rows.length });
  const header = ['run_id', 'started_at', 'status', 'network', 'symbol', 'onchain_balance_base', 'ledger_treasury_base', 'virtual_venue_net_base', 'in_flight_out_base', 'customer_liabilities_base', 'pool_assets_base', 'discrepancy_base'];
  const csv = [header.join(','), ...rows.map((r) => header.map((h) => csvCell(r[h])).join(','))].join('\n');
  return new NextResponse(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="reconciliation.csv"', 'cache-control': 'no-store' } });
});
