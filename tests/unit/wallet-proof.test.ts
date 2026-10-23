import { describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { checkWalletProof, PROOF_MAX_AGE_MS, walletProofMessage, type WalletProofInput } from '../../src/server/deposits/wallet-proof';

const now = new Date('2026-10-24T12:00:00.000Z');
const account = privateKeyToAccount(generatePrivateKey());
const other = privateKeyToAccount(generatePrivateKey());
const base: WalletProofInput = { userId: '11111111-2222-3333-4444-555555555555', networkCode: 'bsc-testnet', address: account.address, issuedAt: now.toISOString() };

async function signed(p = base, signer = account) {
  return { ...p, signature: await signer.signMessage({ message: walletProofMessage(p) }) };
}

describe('wallet ownership proof', () => {
  it('accepts a signature from the wallet being registered and returns the lower-case address', async () => {
    expect(await checkWalletProof(await signed(), now)).toEqual({ ok: true, address: account.address.toLowerCase() });
  });

  it('accepts any address casing, since the message always names the lower-case address', async () => {
    const p = { ...base, address: account.address.toLowerCase() };
    const s = await signed(p);
    expect(await checkWalletProof({ ...s, address: account.address }, now)).toMatchObject({ ok: true });
  });

  it('rejects a signature from a different wallet', async () => {
    expect(await checkWalletProof(await signed(base, other), now)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('binds the user, network and timestamp: changing any of them invalidates the signature', async () => {
    const s = await signed();
    expect(await checkWalletProof({ ...s, userId: '99999999-2222-3333-4444-555555555555' }, now)).toMatchObject({ ok: false, reason: 'bad_signature' });
    expect(await checkWalletProof({ ...s, networkCode: 'bsc-mainnet' }, now)).toMatchObject({ ok: false, reason: 'bad_signature' });
    const later = new Date(now.getTime() + 1000).toISOString();
    expect(await checkWalletProof({ ...s, issuedAt: later }, now)).toMatchObject({ ok: false, reason: 'bad_signature' });
  });

  it('rejects expired and future-dated proofs', async () => {
    const s = await signed();
    expect(await checkWalletProof(s, new Date(now.getTime() + PROOF_MAX_AGE_MS + 1))).toEqual({ ok: false, reason: 'expired' });
    expect(await checkWalletProof(s, new Date(now.getTime() - 10 * 60_000))).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects malformed input without throwing', async () => {
    const s = await signed();
    expect(await checkWalletProof({ ...s, address: '0x1234' }, now)).toEqual({ ok: false, reason: 'invalid_address' });
    expect(await checkWalletProof({ ...s, issuedAt: 'yesterday' }, now)).toEqual({ ok: false, reason: 'bad_timestamp' });
    expect(await checkWalletProof({ ...s, signature: '0xdeadbeef' }, now)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(await checkWalletProof({ ...s, signature: '0x' + 'ab'.repeat(65) }, now)).toEqual({ ok: false, reason: 'bad_signature' });
  });
});
