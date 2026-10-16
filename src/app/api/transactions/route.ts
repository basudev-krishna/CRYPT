import { requireUser } from '@/server/http/auth';
import { json, route } from '@/server/http/api';
import { webDb } from '@/server/db';
import { listActivity } from '@/server/queries/user';

export const GET = route(async (req) => {
  const user = await requireUser();
  const before = req.nextUrl.searchParams.get('before');
  const items = await listActivity(webDb(), user.id, 50, before && /^\d+$/.test(before) ? before : undefined);
  return json({ items, nextCursor: items.length === 50 ? items[items.length - 1]?.entryId : null });
});
