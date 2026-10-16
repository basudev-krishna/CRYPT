import { requirePermission } from '@/server/http/auth';
import { json, route } from '@/server/http/api';
import { webDb } from '@/server/db';
import { adminTrading } from '@/server/queries/admin';

export const GET = route(async () => {
  await requirePermission('console.view');
  return json(await adminTrading(webDb()));
});
