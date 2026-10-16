import { requirePermission } from '@/server/http/auth';
import { json, route } from '@/server/http/api';
import { webDb } from '@/server/db';
import { adminAuditEvents } from '@/server/queries/admin';

export const GET = route(async (req) => {
  await requirePermission('console.view');
  return json(await adminAuditEvents(webDb(), { actor: req.nextUrl.searchParams.get('actor'), action: req.nextUrl.searchParams.get('action') }));
});
