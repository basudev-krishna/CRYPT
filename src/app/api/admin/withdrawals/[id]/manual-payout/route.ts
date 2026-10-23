import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { body, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { one } from '@/server/db-core';
import { adapterForNetwork } from '@/server/web';
import { cancelManualPayout, recordManualPayout } from '@/server/withdrawals/manual-payouts';

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('record'), txHash: z.string().trim().max(80), note: z.string().trim().min(10).max(1000) }),
  z.object({ action: z.literal('cancel'), note: z.string().trim().min(10).max(1000) }),
]);

/** Record the hash of a payout the administrator sent from the group wallet, or decline to send it. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const staff = await requirePermission('withdrawal.payout');
  const input = await body(req, schema);
  const withdrawalId = z.uuid().parse(params.id);
  const actor = await requestActor(staff, 'staff');
  await withWebTransaction(async (db) => {
    if (input.action === 'cancel') return cancelManualPayout(db, { withdrawalId, note: input.note, staffUserId: staff.id, actor });
    const w = await one<{ network_id: number }>(db, 'select network_id from public.withdrawal_requests where id = $1', [withdrawalId]);
    const adapter = await adapterForNetwork(Number(w.network_id), db);
    return recordManualPayout(db, adapter, { withdrawalId, txHash: input.txHash, note: input.note, staffUserId: staff.id, actor });
  });
  return json({ ok: true });
});
