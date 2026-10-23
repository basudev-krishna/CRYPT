'use client';

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
  code?: string;
  details?: unknown;
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

/** JSON POST with optional Idempotency-Key. Never throws; returns a typed result. */
export async function apiPost<T = unknown>(url: string, body: unknown, opts: { idempotencyKey?: string } = {}): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}) },
      body: JSON.stringify(body ?? {}),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, status: res.status, error: json.error ?? 'Request failed', code: json.code, details: json.details };
    return { ok: true, status: res.status, data: json as T };
  } catch {
    return { ok: false, status: 0, error: 'Network error. Check your connection and try again.' };
  }
}

/** JSON DELETE. Never throws; returns a typed result. */
export async function apiDelete<T = unknown>(url: string): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, { method: 'DELETE' });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, status: res.status, error: json.error ?? 'Request failed', code: json.code, details: json.details };
    return { ok: true, status: res.status, data: json as T };
  } catch {
    return { ok: false, status: 0, error: 'Network error. Check your connection and try again.' };
  }
}
