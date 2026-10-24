import { afterAll, describe, expect, it } from 'vitest';
import { admin, closePools } from '../helpers/db';

afterAll(closePools);

/** Runs `fn` in a transaction that is always rolled back, so reference data is left as seeded. */
async function rolledBack(fn: () => Promise<unknown>) {
  await admin.query('begin');
  try {
    return await fn();
  } finally {
    await admin.query('rollback');
  }
}

describe('mainnet_allowlist constraint', () => {
  it('lets bsc-mainnet be activated', async () => {
    await rolledBack(async () => {
      await expect(admin.query("update public.supported_networks set status = 'active' where code = 'bsc-mainnet'")).resolves.toMatchObject({ rowCount: 1 });
    });
  });

  it('refuses every other mainnet, and a bsc-mainnet with another chain id', async () => {
    for (const code of ['eth-mainnet', 'tron-mainnet']) {
      await rolledBack(() => expect(admin.query("update public.supported_networks set status = 'active' where code = $1", [code])).rejects.toThrow(/mainnet_allowlist/));
    }
    await rolledBack(() =>
      expect(admin.query("update public.supported_networks set status = 'active', chain_id = 9999 where code = 'bsc-mainnet'")).rejects.toThrow(/mainnet_allowlist/),
    );
  });

  it('seeds the verified BSC USDT contract disabled, as a real token with 18 decimals', async () => {
    const r = await admin.query(
      `select t.decimals, t.is_test_token, t.status::text, t.min_deposit_base::text
         from public.supported_tokens t join public.supported_networks n on n.id = t.network_id
        where n.code = 'bsc-mainnet' and t.contract_address = '0x55d398326f99059ff775485246999027b3197955'`,
    );
    expect(r.rows).toEqual([{ decimals: 18, is_test_token: false, status: 'disabled', min_deposit_base: (50n * 10n ** 18n).toString() }]);
  });
});
