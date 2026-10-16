import { requireUser } from '@/server/http/auth';
import { json, route } from '@/server/http/api';
import { webDb } from '@/server/db';
import { listNotifications } from '@/server/queries/user';

export const GET = route(async () => {
  const user = await requireUser();
  return json({ items: await listNotifications(webDb(), user.id) });
});

export const POST = route(async () => {
  const user = await requireUser();
  await webDb().query('update public.notification_events set read_at = now() where user_id = $1 and read_at is null', [user.id]);
  return json({ ok: true });
});
