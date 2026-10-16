import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { serverEnv } from '../env';
import { webDb } from '../db';
import { one } from '../db-core';
import { ApiError } from './api';

const MAX_SKEW_MS = 5 * 60_000;

export function signInternal(secret: string, timestamp: string, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/**
 * Service-to-service authentication for /internal/* endpoints:
 *   X-Internal-Timestamp: unix ms
 *   X-Internal-Signature: sha256=HMAC(INTERNAL_API_SECRET, `${timestamp}.${rawBody}`)
 * Rejects stale timestamps (5-minute window) and any signature already used
 * (replay protection, private.claim_internal_nonce). Returns the raw body.
 */
export async function verifyInternal(req: NextRequest): Promise<string> {
  const ts = req.headers.get('x-internal-timestamp') ?? '';
  const sig = req.headers.get('x-internal-signature') ?? '';
  const body = await req.text();
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(Date.now() - t) > MAX_SKEW_MS) throw new ApiError('Unauthorized', 401, 'unauthorized');
  const expected = signInternal(serverEnv().INTERNAL_API_SECRET, ts, body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ApiError('Unauthorized', 401, 'unauthorized');
  const claim = await one<{ ok: boolean }>(webDb(), 'select private.claim_internal_nonce($1) as ok', [expected]);
  if (!claim.ok) throw new ApiError('Unauthorized', 401, 'replayed');
  return body;
}
