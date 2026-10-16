/**
 * Database primitives shared by the web server, workers and tests.
 * (No 'server-only' import so workers and Vitest can use it.)
 */
import pg from 'pg';

export type Db = pg.Pool | pg.PoolClient;

let typesConfigured = false;

/** Keep numeric/int8 as strings so no value ever passes through a JS float. */
export function configurePgTypes(): void {
  if (typesConfigured) return;
  pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => v);
  pg.types.setTypeParser(pg.types.builtins.INT8, (v) => v);
  typesConfigured = true;
}

/** Run fn inside a transaction. Retries serialization failures and deadlocks. */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
  opts: { isolation?: 'read committed' | 'repeatable read' | 'serializable'; retries?: number } = {},
): Promise<T> {
  const { isolation = 'read committed', retries = 3 } = opts;
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    let released = false;
    try {
      await client.query(`begin isolation level ${isolation}`);
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      const code = (err as { code?: string }).code;
      if ((code === '40001' || code === '40P01') && attempt < retries) {
        client.release();
        released = true;
        // Jittered exponential backoff so retried transactions do not collide again in lockstep.
        await new Promise((r) => setTimeout(r, Math.random() * 25 * 2 ** attempt));
        continue;
      }
      throw err;
    } finally {
      if (!released) client.release();
    }
  }
}

export async function one<T extends pg.QueryResultRow>(db: Db, sql: string, params: unknown[] = []): Promise<T> {
  const res = await db.query<T>(sql, params);
  if (res.rowCount !== 1 || !res.rows[0]) throw new Error(`Expected exactly one row, got ${res.rowCount}`);
  return res.rows[0];
}

export async function maybeOne<T extends pg.QueryResultRow>(db: Db, sql: string, params: unknown[] = []): Promise<T | null> {
  const res = await db.query<T>(sql, params);
  return res.rows[0] ?? null;
}

export async function many<T extends pg.QueryResultRow>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await db.query<T>(sql, params);
  return res.rows;
}

/** Errors raised by ledger/state-machine triggers, mapped for callers. */
export function pgErrorCode(err: unknown): string | undefined {
  return (err as { code?: string })?.code;
}
export const PG_INSUFFICIENT_BALANCE = 'P0002';
export const PG_IDEMPOTENCY_CONFLICT = 'P0003';
export const PG_ILLEGAL_TRANSITION = 'P0004';
