import { z } from 'zod';
import { ApiError, json, route } from '@/server/http/api';
import { webDb } from '@/server/db';
import { placementAvailability } from '@/server/referrals/program';

const code = z.string().trim().toUpperCase().regex(/^EW-[0-9]{6,}$/);

/**
 * Public: which team positions a sign-up under this referral id can take.
 * Returns only the referral id and whether each side directly under it is
 * free, never names or other members.
 */
export const GET = route(
  async (req) => {
    const parsed = code.safeParse(req.nextUrl.searchParams.get('ref') ?? '');
    if (!parsed.success) throw new ApiError('Referral ids look like EW-000123', 422, 'invalid_referral');
    const availability = await placementAvailability(webDb(), parsed.data);
    if (!availability) throw new ApiError('That referral id was not found.', 422, 'referral_not_found');
    return json(availability);
  },
  { limit: 30, windowSeconds: 60 },
);
