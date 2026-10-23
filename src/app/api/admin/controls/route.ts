import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { ApiError, body, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { one } from '@/server/db-core';
import { isSoleAdmin, raiseRiskEvent, setControl } from '@/server/ops';
import { canResume } from '@/server/permissions';

const schema = z.object({
  key: z.enum(['withdrawals_paused', 'deposits_paused', 'allocations_paused']),
  enabled: z.boolean(),
  reason: z.string().trim().min(10).max(500),
});

/** Emergency pause (any on-duty staff) and resume (admin, four-eyes; see canResume for a sole admin). */
export const POST = route(async (req) => {
  const input = await body(req, schema);
  const staff = await requirePermission(input.enabled ? 'control.pause' : 'control.resume');
  const actor = await requestActor(staff, 'staff');
  await withWebTransaction(async (db) => {
    const current = await one<{ enabled: boolean; updated_by: string; updated_at: Date }>(
      db,
      'select enabled, updated_by, updated_at from public.system_controls where key = $1 for update',
      [input.key],
    );
    if (!input.enabled && current.enabled) {
      const soleAdmin = await isSoleAdmin(db, staff.id);
      if (!canResume(staff.roles, staff.id, current.updated_by, { soleAdmin, pausedAt: new Date(current.updated_at) })) {
        throw new ApiError(
          soleAdmin
            ? 'You paused this yourself. As the only administrator you can resume it one hour after pausing.'
            : 'A different administrator must resume a pause you enabled',
          403,
          'four_eyes_required',
        );
      }
      if (current.updated_by === `staff:${staff.id}`) {
        await raiseRiskEvent(db, { kind: 'admin_self_resume', severity: 'high', subjectType: 'control', subjectId: input.key, details: { reason: input.reason } });
      }
    }
    await setControl(db, input.key, input.enabled, input.reason, actor);
  });
  return json({ ok: true });
});
