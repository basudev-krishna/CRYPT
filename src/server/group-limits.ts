/**
 * Real-funds policy limits for private group mode, in whole tokens.
 *
 * The seeded policies are in 6-decimal base units (tUSDT), so on BSC USDT
 * (18 decimals) every amount must be rewritten. An amount key without a value
 * here stops the setup instead of being left 10^12 times too small.
 * Change them later by inserting a new policy version.
 */
export const MAINNET_LIMITS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  deposit: { manual_review_above_base: 5_000 },
  withdrawal: {
    fee_base: 0, // no withdrawal fee: the administrator pays BNB gas from the group wallet's own BNB
    max_per_tx_base: 10_000,
    user_daily_limit_base: 20_000,
    global_daily_limit_base: 50_000,
    manual_review_above_base: 1_000,
    new_destination_manual_review_above_base: 500,
    hot_wallet_min_reserve_base: 0,
  },
};

/**
 * Token minimums in whole tokens, set on the token when real funds are activated.
 * No withdrawal minimum and no fee, so any positive amount can be withdrawn.
 */
export const MAINNET_TOKEN_MINIMUMS = { deposit: 50, withdrawal: 0 } as const;

/** Whole-token minimums in base units of `decimals`. */
export function tokenMinimums(decimals: number): { deposit: string; withdrawal: string } {
  const unit = 10n ** BigInt(decimals);
  return { deposit: (BigInt(MAINNET_TOKEN_MINIMUMS.deposit) * unit).toString(), withdrawal: (BigInt(MAINNET_TOKEN_MINIMUMS.withdrawal) * unit).toString() };
}

/** Every `*_base` key of `params`, replaced by its MAINNET_LIMITS value in base units of `decimals`. */
export function scaledLimits(kind: string, params: Record<string, unknown>, decimals: number): Record<string, string> {
  const limits = MAINNET_LIMITS[kind] ?? {};
  const out: Record<string, string> = {};
  for (const key of Object.keys(params).filter((k) => k.endsWith('_base'))) {
    const whole = limits[key];
    if (whole === undefined) throw new Error(`No mainnet value for ${kind}.${key}; add it to MAINNET_LIMITS`);
    out[key] = (BigInt(whole) * 10n ** BigInt(decimals)).toString();
  }
  return out;
}
