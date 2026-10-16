import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { ApiError, body, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { one } from '@/server/db-core';
import { setControl } from '@/server/ops';
import { canResume } from '@/server/permissions';

const schema = z.object({
  key: z.enum(['withdrawals_paused', 'deposits_paused', 'allocations_paused']),
  enabled: z.boolean(),
  reason: z.string().trim().min(10).max(500),
});

/** Emergency pause (any on-duty staff) and resume (admin, four-eyes). */
export const POST = route(async (req) => {
  const input = await body(req, schema);
  const staff = await requirePermission(input.enabled ? 'control.pause' : 'control.resume');
  const actor = await requestActor(staff, 'staff');
  await withWebTransaction(async (db) => {
    const current = await one<{ enabled: boolean; updated_by: string }>(db, 'select enabled, updated_by from public.system_controls where key = $1 for update', [input.key]);
    if (!input.enabled && current.enabled && !canResume(staff.roles, staff.id, current.updated_by)) {
      throw new ApiError('A different administrator must resume a pause you enabled', 403, 'four_eyes_required');
    }
    await setControl(db, input.key, input.enabled, input.reason, actor);
  });
  return json({ ok: true });
});
