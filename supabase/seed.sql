-- =============================================================================
-- LOCAL DEVELOPMENT SEED - never run against a shared or production database.
-- =============================================================================

-- Backend role credentials for local dev only. Production credentials come from
-- the secret manager and are rotated independently.
alter role app_web login password 'app_web_local_dev_only';
alter role app_worker login password 'app_worker_local_dev_only';

-- Networks. Mainnets are present for architecture completeness but disabled; the
-- mainnet_not_active constraint prevents activating them in this phase.
insert into public.supported_networks (code, name, family, chain_id, is_testnet, required_confirmations, status, explorer_tx_url, address_format) values
  ('sim-evm',      'Simulated EVM (development)', 'simulated', null,     true,  3,  'active',   null, 'evm'),
  ('evm-sepolia',  'Ethereum Sepolia (testnet)',  'evm',       11155111, true,  12, 'disabled', 'https://sepolia.etherscan.io/tx/{hash}', 'evm'),
  ('evm-anvil',    'Local Anvil (testnet)',       'evm',       31337,    true,  2,  'disabled', null, 'evm'),
  ('bsc-testnet',  'BNB Smart Chain testnet',     'evm',       97,       true,  15, 'disabled', 'https://testnet.bscscan.com/tx/{hash}', 'evm'),
  ('tron-nile',    'TRON Nile (testnet)',         'tron',      null,     true,  20, 'disabled', 'https://nile.tronscan.org/#/transaction/{hash}', 'tron'),
  ('eth-mainnet',  'Ethereum',                    'evm',       1,        false, 64, 'disabled', 'https://etherscan.io/tx/{hash}', 'evm'),
  ('bsc-mainnet',  'BNB Smart Chain',             'evm',       56,       false, 15, 'disabled', 'https://bscscan.com/tx/{hash}', 'evm'),
  ('tron-mainnet', 'TRON',                        'tron',      null,     false, 20, 'disabled', 'https://tronscan.org/#/transaction/{hash}', 'tron');

-- Tokens. Only the simulated test token is seeded. Production USDT contracts are
-- intentionally NOT seeded: they must be verified against Tether's official
-- publication and added through a reviewed change (see docs/production-readiness.md).
insert into public.supported_tokens (network_id, symbol, name, contract_address, decimals, is_native, is_test_token, status, min_deposit_base, min_withdrawal_base)
select id, 'tUSDT', 'Test USDT (simulated, no value)', '0x00000000000000000000000000000000000057d7', 6, false, true, 'active', 50000000, 10000000
  from public.supported_networks where code = 'sim-evm';
insert into public.supported_tokens (network_id, symbol, name, contract_address, decimals, is_native, is_test_token, status)
select id, 'sETH', 'Simulated gas token', null, 18, true, true, 'active'
  from public.supported_networks where code = 'sim-evm';

-- Treasury hot wallet on the simulated network.
insert into public.treasury_wallets (network_id, kind, address, label, custody_provider, custody_ref)
select id, 'hot', '0x0000000000000000000000000000000000000a07', 'Simulated hot wallet', 'simulated', 'sim-hot-1'
  from public.supported_networks where code = 'sim-evm';

-- Investment pool backed by the simulated trading venue.
insert into public.investment_pools (code, name, token_id, status, is_simulated, venue, inception_navpu, high_water_mark)
select 'core-sim', 'Core Strategy (SIMULATED)', t.id, 'active', true, 'simulated-venue', 1000000, 1000000
  from public.supported_tokens t join public.supported_networks n on n.id = t.network_id
 where n.code = 'sim-evm' and t.symbol = 'tUSDT';

-- Version 1 policies.
insert into public.policy_versions (kind, version, params, change_note, created_by, approved_by) values
('deposit', 1, '{
   "require_kyc_approved": true,
   "below_minimum": "hold_in_suspense",
   "manual_review_above_base": "100000000000",
   "auto_subscribe": true
 }', 'Initial deposit policy', 'seed', 'seed'),
('withdrawal', 1, '{
   "require_kyc_approved": true,
   "require_mfa": true,
   "fee_base": "1000000",
   "max_per_tx_base": "10000000000",
   "user_daily_limit_base": "20000000000",
   "global_daily_limit_base": "200000000000",
   "max_requests_per_hour": 3,
   "manual_review_above_base": "5000000000",
   "new_destination_cooldown_minutes": 2,
   "new_destination_manual_review_above_base": "1000000000",
   "hot_wallet_min_reserve_base": "0",
   "block_on_reconciliation_discrepancy": true
 }', 'Initial withdrawal policy', 'seed', 'seed'),
('fee', 1, '{
   "management_fee_bps_per_year": 200,
   "performance_fee_bps": 1000,
   "high_water_mark": true
 }', 'Initial fee schedule: 2%/yr management, 10% performance over high-water mark', 'seed', 'seed'),
('allocation', 1, '{
   "method": "unitized_forward_pricing",
   "rounding": "down_in_favour_of_pool",
   "valuation_frequency": "hourly"
 }', 'Initial allocation methodology. LOCAL DEV uses hourly strikes so demos are observable; production policy must be daily.', 'seed', 'seed');
