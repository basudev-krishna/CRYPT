import { z } from 'zod';
import { requireUser } from '@/server/http/auth';
import { body, json, rateLimit, route } from '@/server/http/api';
import { webDb } from '@/server/db';
import { getNetwork } from '@/server/chains/registry';
import { walletProofMessage } from '@/server/deposits/member-wallets';

const schema = z.object({ networkId: z.number().int().positive(), address: z.string().trim().regex(/^0x[0-9a-fA-F]{40}$/) });

/** The message the member signs with the wallet they want to register. Nothing is stored until they submit it. */
export const POST = route(async (req) => {
  const user = await requireUser();
  await rateLimit(`user:${user.id}:wallet-challenge`, 3600, 60);
  const { networkId, address } = await body(req, schema);
  const network = await getNetwork(webDb(), networkId);
  const issuedAt = new Date().toISOString();
  return json({ issuedAt, message: walletProofMessage({ userId: user.id, networkCode: network.code, address, issuedAt }) });
});
