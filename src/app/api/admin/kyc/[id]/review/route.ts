import { z } from 'zod';
import { requestActor, requirePermission } from '@/server/http/auth';
import { ApiError, body, json, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { maybeOne } from '@/server/db-core';
import { notify, recordAudit } from '@/server/ops';

const schema = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().trim().min(10).max(1000) });

export const POST = route<{ id: string }>(async (req, { params }) => {
  const staff = await requirePermission('kyc.review');
  const { decision, note } = await body(req, schema);
  const actor = await requestActor(staff, 'staff');
  await withWebTransaction(async (db) => {
    const rec = await maybeOne<Record<string, unknown>>(db, 'select * from public.kyc_records where id = $1', [params.id]);
    if (!rec) throw new ApiError('Not found', 404, 'not_found');
    if (rec.status !== 'pending') throw new ApiError('Record is not pending', 409, 'invalid_state');
    if (rec.user_id === staff.id) throw new ApiError('Staff cannot review their own verification', 403, 'conflict_of_interest');
    // Append a new record; history is never edited.
    await db.query(
      `insert into public.kyc_records (user_id, status, level, provider, provider_ref, full_name, date_of_birth, country_code, document_type, document_last4, submitted_at, reviewed_by, reviewed_at, review_notes)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), $13)`,
      [rec.user_id, decision === 'approve' ? 'approved' : 'rejected', rec.level, rec.provider, rec.provider_ref, rec.full_name, rec.date_of_birth, rec.country_code, rec.document_type, rec.document_last4, rec.submitted_at, staff.id, note],
    );
    await recordAudit(db, actor, `kyc.${decision}`, { type: 'user', id: String(rec.user_id) }, { note, recordId: params.id });
    await notify(db, { userId: String(rec.user_id), kind: `kyc_${decision === 'approve' ? 'approved' : 'rejected'}` });
  });
  return json({ ok: true });
});
