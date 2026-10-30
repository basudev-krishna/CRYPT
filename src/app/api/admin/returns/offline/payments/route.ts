import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { body, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { recordOfflinePayment } from '@/server/returns/offline';
import { enqueue } from '@/server/jobs/web-queue';

const schema = z.object({ userId: z.uuid(), tokenId: z.number().int().positive(), throughDate: z.iso.date(), note: z.string().trim().min(10).max(1000) });

/** Record that the team paid a member's due returns offline, up to a day. Always alerted. */
export const POST = route(async (req) => {
  const staff = await requirePermission('returns.offline');
  const input = await body(req, schema);
  const actor = await requestActor(staff, 'staff');
  const { id } = await withWebTransaction((db) => recordOfflinePayment(db, { ...input, staffUserId: staff.id, actor }));
  await enqueue('returns.process', {}, 'returns').catch(() => null);
  return json({ id }, { status: 201 });
});
