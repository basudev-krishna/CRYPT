import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { body, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { removeFundingWallet } from '@/server/returns/funding';

const schema = z.object({ note: z.string().trim().min(10).max(1000) });

/** Stop treating transfers from this wallet as return funding. Past receipts keep their record. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const staff = await requirePermission('returns.configure');
  const { note } = await body(req, schema);
  const walletId = z.uuid().parse(params.id);
  const actor = await requestActor(staff, 'staff');
  await withWebTransaction((db) => removeFundingWallet(db, { walletId, note, staffUserId: staff.id, actor }));
  return json({ ok: true });
});
