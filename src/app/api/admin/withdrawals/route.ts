import { requirePermission } from '@/server/http/auth';
import { json, route } from '@/server/http/api';
import { webDb } from '@/server/db';
import { adminWithdrawals } from '@/server/queries/admin';

export const GET = route(async (req) => {
  await requirePermission('console.view');
  return json(await adminWithdrawals(webDb(), req.nextUrl.searchParams.get('status')));
});
