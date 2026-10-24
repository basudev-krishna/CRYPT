-- =============================================================================
-- Real funds, narrowly: BNB Smart Chain mainnet for the watch-only group wallet.
--
-- The app still holds no keys (CUSTODY_PROVIDER=manual) and the web server and
-- worker refuse REAL_FUNDS_ENABLED outside private group mode (phase-guard.ts).
-- Every other mainnet stays impossible to activate.
-- =============================================================================

alter table public.supported_networks drop constraint mainnet_not_active;
-- Mirrors REAL_FUNDS_NETWORKS in src/server/phase-guard.ts.
alter table public.supported_networks add constraint mainnet_allowlist
  check (is_testnet or status <> 'active' or (code = 'bsc-mainnet' and family = 'evm' and chain_id = 56));

-- USDT on BSC ("Binance-Peg BSC-USD"). Issued by Binance as a pegged token, not by
-- Tether on its own chain list; 18 decimals, unlike USDT on Ethereum/TRON (6).
-- Address verified on bscscan.com/token/0x55d398326f99059ff775485246999027b3197955.
-- The EVM adapter re-checks decimals on chain before scanning. Starts disabled;
-- `scripts/setup-staging.ts group-mode bsc-mainnet ...` activates it.
-- Minimums: 50 USDT deposit, no withdrawal minimum.
insert into public.supported_tokens (network_id, symbol, name, contract_address, decimals, is_native, is_test_token, status, min_deposit_base, min_withdrawal_base)
select n.id, 'USDT', 'Tether USD (BSC-USD, BEP20)', '0x55d398326f99059ff775485246999027b3197955', 18, false, false, 'disabled',
       50 * power(10::numeric, 18), 0
  from public.supported_networks n
 where n.code = 'bsc-mainnet' and n.chain_id = 56
   and not exists (select 1 from public.supported_tokens t where t.network_id = n.id and t.contract_address = '0x55d398326f99059ff775485246999027b3197955');
