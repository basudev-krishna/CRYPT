import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { body, json, route } from '@/server/http/api';
import { webDb, withWebTransaction } from '@/server/db';
import { issueInvitation, MAX_INVITE_DAYS, MIN_INVITE_DAYS } from '@/server/membership';
import { adminInvitations } from '@/server/queries/admin';

const schema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  sponsorMemberCode: z.string().trim().max(20).nullish().transform((v) => v || null),
  note: z.string().trim().min(10).max(500),
  validDays: z.number().int().min(MIN_INVITE_DAYS).max(MAX_INVITE_DAYS).default(14),
});

export const GET = route(async () => {
  await requirePermission('console.view');
  return json(await adminInvitations(webDb()));
});

/** Issue a single-use invitation. The code is in this response only; it is never stored or shown again. */
export const POST = route(async (req) => {
  const staff = await requirePermission('member.invite');
  const input = await body(req, schema);
  const actor = await requestActor(staff, 'staff');
  const inv = await withWebTransaction((db) => issueInvitation(db, actor, input));
  return json(inv, { status: 201 });
}, { limit: 20, windowSeconds: 3600 });
