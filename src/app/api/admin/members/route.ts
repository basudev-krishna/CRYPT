import { requestActor, requirePermission } from '@/server/http/auth';
import { ApiError, body, json, route } from '@/server/http/api';
import { webDb, withWebTransaction } from '@/server/db';
import { adminMemberSchema, checkAdminMember, createAuthAccount, placeAdminMember } from '@/server/admin-members';

/** Administrator: create a member account with a sponsor and a team position. */
export const POST = route(
  async (req) => {
    const staff = await requirePermission('network.manage');
    const input = await body(req, adminMemberSchema);
    await checkAdminMember(webDb(), input);
    const userId = await createAuthAccount(input, req.nextUrl.origin);
    const actor = await requestActor(staff, 'staff');
    try {
      const { memberCode } = await withWebTransaction((db) => placeAdminMember(db, { userId, input, staffUserId: staff.id, actor }));
      return json({ userId, memberCode }, { status: 201 });
    } catch (err) {
      // The account exists either way; only the position failed, and it can be set on the member's page.
      const reason = err instanceof Error && err.name !== 'Error' ? err.message : 'an unexpected error';
      throw new ApiError(`The account was created, but placing it failed (${reason}). Set the position on the member's page.`, 422, 'placement_failed');
    }
  },
  { limit: 30, windowSeconds: 600 },
);
