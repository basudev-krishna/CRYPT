import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { body, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { addFundingWallet } from '@/server/returns/funding';

const schema = z.object({ networkId: z.number().int().positive(), address: z.string().trim().max(60), label: z.string().trim().min(3).max(80) });

/** Register a company wallet whose transfers to the group wallet fund daily returns automatically. Always alerted. */
export const POST = route(async (req) => {
  const staff = await requirePermission('returns.configure');
  const input = await body(req, schema);
  const actor = await requestActor(staff, 'staff');
  const { id } = await withWebTransaction((db) => addFundingWallet(db, { ...input, staffUserId: staff.id, actor }));
  return json({ id }, { status: 201 });
});
