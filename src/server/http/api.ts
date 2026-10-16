import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { AuthError } from './auth';
import { webDb } from '../db';
import { one } from '../db-core';
import { AmountError } from '@/lib/money';

/** Serialize bigint as string everywhere in API responses. */
export function json(data: unknown, init?: ResponseInit): NextResponse {
  const body = JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  return new NextResponse(body, { ...init, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...(init?.headers ?? {}) } });
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Domain errors carry a `code`; map them to 4xx without leaking internals. */
function toResponse(err: unknown): NextResponse {
  if (err instanceof ApiError) return json({ error: err.message, code: err.code, details: err.details }, { status: err.status });
  if (err instanceof AuthError) return json({ error: err.message, code: err.code }, { status: err.status });
  if (err instanceof z.ZodError) return json({ error: 'Invalid request', code: 'validation_error', details: z.flattenError(err).fieldErrors }, { status: 400 });
  if (err instanceof AmountError) return json({ error: err.message, code: 'invalid_amount' }, { status: 400 });
  // Domain errors are our own Error subclasses with a lower-case snake_case code
  // (e.g. WithdrawalError 'policy_rejected'). Node/pg/system errors (ECONNREFUSED,
  // SQLSTATEs) never match, so their messages are not returned to clients.
  const e = err as { name?: string; code?: unknown; message?: string; checks?: unknown };
  if (e?.name && e.name !== 'Error' && /Error$/.test(e.name) && typeof e.code === 'string' && /^[a-z][a-z0-9_]*$/.test(e.code)) {
    return json({ error: e.message, code: e.code, details: e.checks }, { status: 422 });
  }
  if (e?.code === 'P0002') return json({ error: 'Insufficient balance', code: 'insufficient_balance' }, { status: 422 });
  console.error('[api] unhandled error', err);
  return json({ error: 'Internal error', code: 'internal' }, { status: 500 });
}

/** Reject cross-site state-changing requests (CSRF defense on top of SameSite cookies). */
function assertSameOrigin(req: NextRequest): void {
  if (req.method === 'GET' || req.method === 'HEAD') return;
  const origin = req.headers.get('origin');
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (!origin || !host || new URL(origin).host !== host) throw new ApiError('Cross-origin request rejected', 403, 'csrf');
}

export async function rateLimit(bucket: string, windowSeconds: number, limit: number): Promise<void> {
  const r = await one<{ ok: boolean }>(webDb(), 'select public.rate_limit_hit($1, $2, $3) as ok', [bucket, windowSeconds, limit]);
  if (!r.ok) throw new ApiError('Too many requests, slow down', 429, 'rate_limited');
}

/**
 * Client IP for rate limiting. Proxies append to X-Forwarded-For, so only the
 * entries added by our own infrastructure are trustworthy: take the entry
 * TRUSTED_PROXY_HOPS (default 1) from the right. Leftmost values are client
 * supplied and must never be used.
 */
export function clientIp(req: NextRequest, hops = Number(process.env.TRUSTED_PROXY_HOPS ?? 1)): string {
  const chain = (req.headers.get('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const n = Number.isInteger(hops) && hops > 0 ? hops : 1;
  return chain[chain.length - n] ?? req.headers.get('x-real-ip') ?? 'unknown';
}

type Handler<P> = (req: NextRequest, ctx: { params: P }) => Promise<NextResponse>;

/** Wrap a route handler with origin checks, a per-IP rate limit and error mapping. */
export function route<P = Record<string, string>>(fn: Handler<P>, opts: { limit?: number; windowSeconds?: number; skipOriginCheck?: boolean } = {}) {
  return async (req: NextRequest, ctx: { params: Promise<P> }) => {
    try {
      if (!opts.skipOriginCheck) assertSameOrigin(req);
      await rateLimit(`ip:${clientIp(req)}:${req.nextUrl.pathname}`, opts.windowSeconds ?? 60, opts.limit ?? 120);
      return await fn(req, { params: await ctx.params });
    } catch (err) {
      return toResponse(err);
    }
  };
}

export async function body<T extends z.ZodType>(req: NextRequest, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiError('Request body must be JSON', 400, 'invalid_json');
  }
  return schema.parse(raw);
}

export const idempotencyKey = (req: NextRequest): string => {
  const key = req.headers.get('idempotency-key');
  if (!key || !/^[A-Za-z0-9_-]{16,100}$/.test(key)) throw new ApiError('Idempotency-Key header (16-100 url-safe chars) is required', 400, 'idempotency_key_required');
  return key;
};
