import { z } from 'zod';
import { requestActor, requireUser } from '@/server/http/auth';
import { ApiError, body, json, rateLimit, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { getKycStatus } from '@/server/compliance/compliance';
import { recordAudit } from '@/server/ops';

/**
 * Basic identity submission for compliance review. Only the last four
 * characters of the document number are stored; a production deployment must
 * integrate a regulated KYC vendor (document + liveness checks).
 */
const schema = z.object({
  fullName: z.string().trim().min(3).max(120),
  dateOfBirth: z.iso.date(),
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  documentType: z.enum(['passport', 'national_id', 'driving_licence']),
  documentLast4: z.string().regex(/^[A-Za-z0-9]{4}$/),
});

export const POST = route(async (req) => {
  const user = await requireUser();
  await rateLimit(`user:${user.id}:kyc`, 3600, 5);
  const input = await body(req, schema);
  const actor = await requestActor(user);
  await withWebTransaction(async (db) => {
    const status = await getKycStatus(db, user.id);
    if (status === 'approved' || status === 'pending') throw new ApiError(`Verification is already ${status}`, 409, 'kyc_exists');
    const row = await db.query(
      `insert into public.kyc_records (user_id, status, provider, full_name, date_of_birth, country_code, document_type, document_last4, submitted_at)
       values ($1, 'pending', 'manual', $2, $3, $4, $5, $6, now()) returning id`,
      [user.id, input.fullName, input.dateOfBirth, input.countryCode, input.documentType, input.documentLast4.toUpperCase()],
    );
    await recordAudit(db, actor, 'kyc.submitted', { type: 'kyc_record', id: row.rows[0].id });
  });
  return json({ status: 'pending' }, { status: 201 });
});
