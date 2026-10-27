import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { body, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { updateHolder } from '@/server/offchain/holdings';

const schema = z.object({ name: z.string().trim().min(2).max(80), note: z.string().trim().max(500).nullable().optional() });

/** Rename a holder or change the private note. Balances change only through entries. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const staff = await requirePermission('offchain.record');
  const input = await body(req, schema);
  const holderId = z.uuid().parse(params.id);
  const actor = await requestActor(staff, 'staff');
  await withWebTransaction((db) => updateHolder(db, { ...input, holderId, actor }));
  return json({ ok: true });
});
