import { json, route } from '@/server/http/api';
import { webDb } from '@/server/db';
import { listActiveTokens } from '@/server/queries/user';

export const GET = route(async () => json({ items: await listActiveTokens(webDb()) }));
