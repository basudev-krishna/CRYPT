import { z } from 'zod';
import { requestActor, requireUser } from '@/server/http/auth';
import { body, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { recordAudit } from '@/server/ops';

const schema = z.object({ displayName: z.string().trim().max(60).nullable(), countryCode: z.string().regex(/^[A-Z]{2}$/).nullable() });

export const POST = route(async (req) => {
  const user = await requireUser();
  const input = await body(req, schema);
  const actor = await requestActor(user);
  await withWebTransaction(async (db) => {
    await db.query('update public.user_profiles set display_name = $2, country_code = $3 where user_id = $1', [user.id, input.displayName, input.countryCode]);
    await recordAudit(db, actor, 'profile.updated', { type: 'user', id: user.id });
  });
  return json({ ok: true });
});
