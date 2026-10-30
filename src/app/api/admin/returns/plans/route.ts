import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { body, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { createPlan } from '@/server/returns/service';
import { percentToPpm } from '@/server/returns/math';

const schema = z.object({
  name: z.string().trim().min(3).max(80),
  tokenId: z.number().int().positive(),
  dailyRatePercent: z.string().trim().max(10),
  minPrincipal: z.string().trim().min(1).max(40),
  termDays: z.number().int().positive().max(3650).nullable(),
  payableAfterDays: z.number().int().min(0).max(3650),
  principalLockDays: z.number().int().min(0).max(3650),
  termsReference: z.string().trim().min(5).max(500),
});

/** Draft a daily-return plan. Terms are immutable; it creates no obligation until another administrator activates it. */
export const POST = route(async (req) => {
  const staff = await requirePermission('returns.configure');
  const input = await body(req, schema);
  const actor = await requestActor(staff, 'staff');
  let dailyRatePpm: number;
  try {
    dailyRatePpm = percentToPpm(input.dailyRatePercent);
  } catch (err) {
    return json({ error: (err as Error).message, code: 'invalid_rate' }, { status: 400 });
  }
  const { id } = await withWebTransaction((db) => createPlan(db, { ...input, dailyRatePpm, staffUserId: staff.id, actor }));
  return json({ id }, { status: 201 });
});
