import { z } from 'zod';
import { requestActor, requireUser } from '@/server/http/auth';
import { ApiError, body, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { recordAudit } from '@/server/ops';
import { RISK_DISCLOSURE_VERSION } from '@/lib/disclosures';

const schema = z.object({ version: z.string() });

export const POST = route(async (req) => {
  const user = await requireUser();
  const { version } = await body(req, schema);
  if (version !== RISK_DISCLOSURE_VERSION) throw new ApiError('Disclosure version is out of date; reload the page', 409, 'stale_disclosure');
  const actor = await requestActor(user);
  await withWebTransaction(async (db) => {
    await db.query('update public.user_profiles set risk_disclosure_accepted_at = now(), risk_disclosure_version = $2 where user_id = $1', [user.id, version]);
    await recordAudit(db, actor, 'disclosure.accepted', { type: 'user', id: user.id }, { version });
  });
  return json({ ok: true });
});
