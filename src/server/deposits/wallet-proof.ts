/**
 * Wallet-ownership proofs for group-wallet deposits (pure; see member-wallets.ts).
 * Only plain-key (EOA) signatures verify; smart-contract wallets are not supported.
 */
import { getAddress, isAddress, verifyMessage, type Hex } from 'viem';

/** A signed proof older than this is refused, so a leaked old signature is of little use. */
export const PROOF_MAX_AGE_MS = 30 * 60_000;
const PROOF_CLOCK_SKEW_MS = 5 * 60_000;

export interface WalletProofInput {
  userId: string;
  networkCode: string;
  address: string;
  issuedAt: string; // ISO-8601, chosen by the server and echoed back by the client
}

/** The exact text the wallet signs. Any change here invalidates outstanding proofs. */
export function walletProofMessage(p: WalletProofInput): string {
  return [
    'EliteWhale: register this wallet for group deposits.',
    'Signing proves you control it. It does not move funds or cost gas.',
    '',
    `User: ${p.userId}`,
    `Network: ${p.networkCode}`,
    `Address: ${p.address.toLowerCase()}`,
    `Issued: ${p.issuedAt}`,
  ].join('\n');
}

export type ProofCheck = { ok: true; address: string } | { ok: false; reason: 'invalid_address' | 'expired' | 'bad_timestamp' | 'bad_signature' };

/** Verify a wallet-ownership proof. Pure apart from signature recovery. */
export async function checkWalletProof(p: WalletProofInput & { signature: string }, now: Date = new Date()): Promise<ProofCheck> {
  if (!isAddress(p.address, { strict: false })) return { ok: false, reason: 'invalid_address' };
  const issued = Date.parse(p.issuedAt);
  if (!Number.isFinite(issued) || new Date(issued).toISOString() !== p.issuedAt) return { ok: false, reason: 'bad_timestamp' };
  if (issued > now.getTime() + PROOF_CLOCK_SKEW_MS || now.getTime() - issued > PROOF_MAX_AGE_MS) return { ok: false, reason: 'expired' };
  if (!/^0x[0-9a-fA-F]{130}$/.test(p.signature)) return { ok: false, reason: 'bad_signature' };
  let valid = false;
  try {
    valid = await verifyMessage({ address: getAddress(p.address), message: walletProofMessage(p), signature: p.signature as Hex });
  } catch {
    valid = false;
  }
  return valid ? { ok: true, address: p.address.toLowerCase() } : { ok: false, reason: 'bad_signature' };
}
