import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { body, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { linkHolder } from '@/server/offchain/holdings';

const schema = z.object({ memberCode: z.string().trim().regex(/^EW-[0-9]{6,}$/i, 'Member ids look like EW-000123') });

/** Link a holder to a member account (once), so the member can see their off-platform balance. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const staff = await requirePermission('offchain.record');
  const { memberCode } = await body(req, schema);
  const holderId = z.uuid().parse(params.id);
  const actor = await requestActor(staff, 'staff');
  await withWebTransaction((db) => linkHolder(db, { holderId, memberCode, staffUserId: staff.id, actor }));
  return json({ ok: true });
});
