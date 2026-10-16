import 'server-only';
import pg from 'pg';
import { serverEnv } from './env';
import { configurePgTypes, withTransaction as withTx, type Db } from './db-core';

configurePgTypes();

let pool: pg.Pool | undefined;

/** Connection pool for the Next.js server (role: app_web). */
export function webDb(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: serverEnv().DATABASE_URL_WEB,
      max: 5,
      idleTimeoutMillis: 10_000,
      statement_timeout: 15_000,
      application_name: 'elitewhale-web',
    });
  }
  return pool;
}

export function withWebTransaction<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  return withTx(webDb(), fn);
}

export type { Db };
