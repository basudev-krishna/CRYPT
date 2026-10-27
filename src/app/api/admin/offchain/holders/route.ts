import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { body, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { createHolder } from '@/server/offchain/holdings';

const schema = z.object({ name: z.string().trim().min(2).max(80), note: z.string().trim().max(500).nullable().optional() });

/** Record a person who handed the administrator money off-platform. */
export const POST = route(async (req) => {
  const staff = await requirePermission('offchain.record');
  const input = await body(req, schema);
  const actor = await requestActor(staff, 'staff');
  const { id } = await withWebTransaction((db) => createHolder(db, { ...input, staffUserId: staff.id, actor }));
  return json({ id }, { status: 201 });
});
