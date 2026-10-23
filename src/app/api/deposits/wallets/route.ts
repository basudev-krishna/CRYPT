import { z } from 'zod';
import { requestActor, requireUser } from '@/server/http/auth';
import { body, json, rateLimit, route } from '@/server/http/api';
import { webDb, withWebTransaction } from '@/server/db';
import { listMemberWallets, registerMemberWallet } from '@/server/deposits/member-wallets';

export const GET = route(async () => {
  const user = await requireUser();
  return json({ items: await listMemberWallets(webDb(), user.id) });
});

const schema = z.object({
  networkId: z.number().int().positive(),
  address: z.string().trim().regex(/^0x[0-9a-fA-F]{40}$/),
  issuedAt: z.string().max(40),
  signature: z.string().trim().regex(/^0x[0-9a-fA-F]{130}$/, 'Paste the full signature (0x followed by 130 hex characters)'),
});

/** Register a sending wallet with a signed ownership proof (see /challenge). */
export const POST = route(async (req) => {
  const user = await requireUser();
  await rateLimit(`user:${user.id}:wallet-register`, 3600, 20);
  const input = await body(req, schema);
  const actor = await requestActor(user);
  const wallet = await withWebTransaction((db) => registerMemberWallet(db, { userId: user.id, ...input, actor }));
  return json(wallet, { status: 201 });
});
