import { z } from 'zod';
import { requestActor, requireUser } from '@/server/http/auth';
import { ApiError, body, json, rateLimit, route } from '@/server/http/api';
import { withWebTransaction } from '@/server/db';
import { serverEnv } from '@/server/env';
import { getDepositToken, getNetwork } from '@/server/chains/registry';
import { insertSimTransfer } from '@/server/chains/simulated';
import { recordAudit } from '@/server/ops';
import { parseUnits } from '@/lib/money';
import { one } from '@/server/db-core';
import { getGroupWallet } from '@/server/deposits/service';
import { listMemberWallets } from '@/server/deposits/member-wallets';

/**
 * DEMO MODE ONLY. Simulates an external wallet sending test tokens to the
 * caller's own deposit address (or the group wallet) on the SIMULATED network. The deposit then goes
 * through the normal detection -> confirmation -> checks -> credit pipeline.
 */
const schema = z.object({ amount: z.string().max(20), fromAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional() });

export const POST = route(async (req) => {
  if (!serverEnv().DEMO_MODE) throw new ApiError('Not found', 404, 'not_found');
  const user = await requireUser();
  await rateLimit(`user:${user.id}:sim-deposit`, 3600, 20);
  const input = await body(req, schema);
  const actor = await requestActor(user);
  const res = await withWebTransaction(async (db) => {
    const network = await getNetwork(db, 'sim-evm');
    const token = await getDepositToken(db, network.id);
    if (!token?.contractAddress) throw new ApiError('Simulated token missing', 500, 'config');
    const amount = parseUnits(input.amount, token.decimals);
    if (amount <= 0n || amount > parseUnits('100000', token.decimals)) throw new ApiError('Amount must be between 0 and 100,000', 400, 'invalid_amount');
    // Group wallet: send to the shared address from the member's first registered wallet,
    // so attribution by sender is exercised. Otherwise send to their own deposit address.
    const group = await getGroupWallet(db, network.id);
    const to = group
      ? group.address
      : (
          await one<{ address: string }>(db, "select address from public.deposit_addresses where user_id = $1 and network_id = $2 and status = 'active'", [user.id, network.id]).catch(() => {
            throw new ApiError('Request deposit instructions first', 409, 'no_address');
          })
        ).address;
    const registered = group ? (await listMemberWallets(db, user.id)).find((w) => w.networkId === network.id) : undefined;
    const tx = await insertSimTransfer(db, {
      networkId: network.id,
      tokenContract: token.contractAddress,
      from: input.fromAddress ?? registered?.address ?? '0x5151515151515151515151515151515151515151',
      to,
      amount,
    });
    await recordAudit(db, actor, 'dev.simulated_deposit', { type: 'sim_tx', id: tx.txHash }, { amountBase: amount });
    return tx;
  });
  return json({ txHash: res.txHash, simulated: true }, { status: 201 });
});
