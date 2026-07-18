// Drift v2 Spot market config for Cardo `/lend-drift`.
//
// The page targets one canonical market per release. Switch markets by
// editing this file; the hook + screen are market-agnostic.
//
// Devnet bootstrap state (verified 2026-04-25 via getProgramAccounts +
// SpotMarket struct decode):
//
//   * 9 SpotMarkets total — USDC (idx 0), SOL (idx 1), BTC (idx 2),
//     "Default Market Name" (idx 3), Bonk (idx 4), JLP (idx 5),
//     USDC-rotation (idx 6), PLXY (idx 7), GLXY (idx 8)
//
// First wiring chooses **SOL (idx 1)** because:
//   - Mint = `So11…112` (canonical WSOL), which Cardo already wraps as
//     WWSOL on Rome → no new ERC20-SPL deploy needed.
//   - Drift Spot SOL has live oracle + a populated vault.
//   - WUSDC ↔ USDC (idx 0) requires the user to bridge to Mango's
//     non-canonical devnet USDC mint `8zGuJQqw…`, which doesn't match
//     Cardo's chain_mint_id — a separate wiring story.
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md
// (Family 5 — Drift Spot deposit/withdraw).

import type { Hex } from 'viem';
import { pubkeyBs58ToBytes32 } from './solana-pda';

export type DriftSpotMarketConfig = {
  /// Display label.
  symbol: string;
  /// Drift's u16 market_index (passed as the deposit/withdraw arg).
  marketIndex: number;
  /// SpotMarket PDA, bytes32 (passed as a remaining account).
  spotMarketPda: Hex;
  /// SpotMarket's vault account (writable in deposit/withdraw).
  spotMarketVault: Hex;
  /// Oracle account (passed as a remaining account, read-only).
  oraclePda: Hex;
  /// SPL mint backing the market.
  mintBs58: string;
  mintHex: Hex;
  /// EVM ERC20-SPL wrapper on Rome that maps to the same SPL.
  wrapper: `0x${string}`;
  /// Mint decimals.
  decimals: number;
};

/// Active market: Drift Spot USDC market_index=6 on devnet, oracle =
/// `PythStableCoinPull` (Pyth Solana Receiver, regular Pyth Pull format).
///
/// **Bisection 2026-04-26**: market_index=1 (SOL) reverted with
/// `Custom(6087) SpotMarketNotFound` from `user.rs:694`. The on-chain
/// SpotMarket #1 references a `PythLazerOracle` (Drift-owned, 48 bytes,
/// disc `9f07a1f922517985`). Devnet's PythLazer `posted_slot` is 4.3M
/// slots stale, and the deployed Drift program's `OracleMap::load` may
/// not yet recognize PythLazer in its known-oracles list (Drift master
/// supports it, but devnet program version is unverified). Switching to
/// market 6 — same mint type (USDC) but with a normal Pyth Pull oracle
/// owned by `G6EoTTTgpkNBtVXo96EQp2m6uwwVh2Kt6YidjkmQqoha` (Pyth Solana
/// Receiver) — bypasses the Drift-internal-oracle path entirely.
///
/// Note: this devnet USDC mint (`8zGuJQqw…`) is a separate Drift test
/// mint, NOT Rome's chain_mint_id USDC (`4zMMC9sr…`). The wrapper for
/// `8zGuJQqw…` doesn't exist on Rome yet; WrapperGate will surface a
/// "deploy wrapper" CTA on first visit.
export const DRIFT_SPOT_SOL: DriftSpotMarketConfig = {
  symbol: 'USDC',
  marketIndex: 6,
  spotMarketPda: pubkeyBs58ToBytes32(
    '6Aq7WBtsZVyumcRxpAoKNyWb97gAzp3be2LeQ9yE6SVX',
  ),
  spotMarketVault: pubkeyBs58ToBytes32(
    '2AG6YN9Wi7JDrFcLNhaEP2NrXyZKFj7EjMPdkvwPdRR1',
  ),
  oraclePda: pubkeyBs58ToBytes32(
    'En8hkHLkRe9d9DraYmBTrus518BvmVH448YcvmrFM6Ce',
  ),
  mintBs58: '8zGuJQqwhZafTah7Uc7Z4tXRnguqkn5KLFAP8oV6PHe2',
  mintHex: pubkeyBs58ToBytes32(
    '8zGuJQqwhZafTah7Uc7Z4tXRnguqkn5KLFAP8oV6PHe2',
  ),
  wrapper: '0xda85a0fF2fB3BF8Ee939B84a9fb379fd3b5043D9', // WUSDCdrift, deployed 2026-04-26
  decimals: 6,
};

/// Default registry of markets the `/lend-drift` UI exposes today.
/// Keep this short; expand only when a new wiring is verified
/// end-to-end against Rome.
export const ENABLED_DRIFT_SPOT_MARKETS: DriftSpotMarketConfig[] = [
  DRIFT_SPOT_SOL,
];
