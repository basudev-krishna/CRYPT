import { requireUser } from '@/server/http/auth';
import { json, route } from '@/server/http/api';
import { webDb } from '@/server/db';
import { getDashboard } from '@/server/queries/user';

export const GET = route(async () => {
  const user = await requireUser();
  return json(await getDashboard(webDb(), user.id));
});
