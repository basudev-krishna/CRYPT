import 'server-only';
import { webDb } from './db';
import type { Db } from './db-core';
import { getAdapter, getNetwork } from './chains/registry';
import { getCustodyProvider } from './custody/simulated';

/** Chain adapter for request-time validation (address checks, investigations). */
export async function adapterForNetwork(networkId: number, db: Db = webDb()) {
  return getAdapter(await getNetwork(db, networkId), db);
}

export function custody(db: Db = webDb()) {
  return getCustodyProvider(db);
}
