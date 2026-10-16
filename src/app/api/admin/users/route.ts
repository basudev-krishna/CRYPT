import { requirePermission } from '@/server/http/auth';
import { json, route } from '@/server/http/api';
import { webDb } from '@/server/db';
import { adminUsers } from '@/server/queries/admin';

export const GET = route(async (req) => {
  await requirePermission('console.view');
  return json(await adminUsers(webDb(), req.nextUrl.searchParams.get('q')?.slice(0, 100) || null));
});
