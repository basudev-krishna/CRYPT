/**
 * KYC / account-status lookups and address screening.
 */
import { maybeOne, type Db } from '../db-core';

export type KycStatus = 'not_started' | 'pending' | 'approved' | 'rejected' | 'expired';
export type AccountStatus = 'active' | 'restricted' | 'frozen' | 'closed';

export async function getKycStatus(db: Db, userId: string): Promise<KycStatus> {
  const row = await maybeOne<{ status: KycStatus }>(db, 'select status from public.user_kyc_current where user_id = $1', [userId]);
  return row?.status ?? 'not_started';
}

export async function getAccountStatus(db: Db, userId: string): Promise<AccountStatus | null> {
  const row = await maybeOne<{ account_status: AccountStatus }>(db, 'select account_status from public.user_profiles where user_id = $1', [userId]);
  return row?.account_status ?? null;
}

// -----------------------------------------------------------------------------
// Address screening
// -----------------------------------------------------------------------------
export interface ScreeningResult {
  provider: string;
  isSimulated: boolean;
  risk: 'low' | 'medium' | 'high' | 'severe';
  reasons: string[];
}

export interface AddressScreeningProvider {
  screen(networkCode: string, address: string): Promise<ScreeningResult>;
}

/**
 * MOCK screening provider. Flags addresses from SCREENING_BLOCKLIST and, for
 * tests, any address ending in "bad0". A production deployment must replace
 * this with a sanctions / wallet-risk vendor (e.g. Chainalysis, TRM, Elliptic).
 */
export class MockScreeningProvider implements AddressScreeningProvider {
  private readonly blocklist: Set<string>;
  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.blocklist = new Set(
      (env.SCREENING_BLOCKLIST ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    );
  }

  async screen(_networkCode: string, address: string): Promise<ScreeningResult> {
    const a = address.toLowerCase();
    if (this.blocklist.has(a)) return { provider: 'mock', isSimulated: true, risk: 'severe', reasons: ['address on blocklist'] };
    if (a.endsWith('bad0')) return { provider: 'mock', isSimulated: true, risk: 'high', reasons: ['test high-risk address pattern'] };
    return { provider: 'mock', isSimulated: true, risk: 'low', reasons: [] };
  }
}

export function getScreeningProvider(env: NodeJS.ProcessEnv = process.env): AddressScreeningProvider {
  return new MockScreeningProvider(env);
}
