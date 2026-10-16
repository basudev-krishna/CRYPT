import { requireUser } from '@/server/http/auth';
import { json, route } from '@/server/http/api';
import { webDb } from '@/server/db';
import { getProfile } from '@/server/queries/user';

export const GET = route(async () => {
  const user = await requireUser();
  const profile = await getProfile(webDb(), user.id);
  return json({ id: user.id, email: user.email, aal: user.aal, mfaEnrolled: user.hasMfaFactor, roles: user.roles, profile });
});
