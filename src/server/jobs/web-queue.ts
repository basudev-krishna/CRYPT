import 'server-only';
import { PgBoss } from 'pg-boss';
import { serverEnv } from '../env';
import type { JobPayloads } from './queues';

let boss: Promise<PgBoss> | undefined;

/** Send-only pg-boss client for the web role. The worker owns and maintains the schema. */
function client(): Promise<PgBoss> {
  if (!boss) {
    const b = new PgBoss({
      connectionString: serverEnv().DATABASE_URL_WEB,
      schema: 'pgboss',
      supervise: false,
      schedule: false,
      migrate: false,
      createSchema: false,
      max: 2,
    });
    b.on('error', (err) => console.error('[pgboss:web]', err));
    boss = b.start().then(() => b);
  }
  return boss;
}

export async function enqueue<K extends keyof JobPayloads>(name: K, data: JobPayloads[K], singletonKey?: string): Promise<string | null> {
  if (serverEnv().JOBS_MODE === 'inline') {
    // No worker: do the work now. A job that fails here stays pending and is picked up by the next sync.
    if (name === 'dead-letter') return null;
    const { runJobInline } = await import('./inline');
    const r = await runJobInline(name as Exclude<K, 'dead-letter'>, data as JobPayloads[Exclude<K, 'dead-letter'>]);
    return r.failed.length ? null : 'inline';
  }
  const b = await client();
  return b.send(name, data as object, singletonKey ? { singletonKey, singletonSeconds: 10 } : {});
}
