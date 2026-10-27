import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { body, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { recordMoveToPlatform } from '@/server/offchain/holdings';

const schema = z.object({ allocationId: z.uuid(), reason: z.string().trim().min(10).max(1000) });

/** Match a posted group-wallet assignment to the holder: that much is now on the platform. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const staff = await requirePermission('offchain.record');
  const { allocationId, reason } = await body(req, schema);
  const holderId = z.uuid().parse(params.id);
  const actor = await requestActor(staff, 'staff');
  // One match per allocation, so the allocation id is the natural idempotency key.
  const { id } = await withWebTransaction((db) =>
    recordMoveToPlatform(db, { holderId, allocationId, reason, idempotencyKey: `move:${allocationId}`, staffUserId: staff.id, actor }),
  );
  return json({ id }, { status: 201 });
});
