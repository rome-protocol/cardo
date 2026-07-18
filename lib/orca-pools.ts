// Curated registry of Orca Whirlpools that Cardo /swap-orca supports.
//
// Each pool entry pins the constants needed by the swap adapter
// (vault addresses, mints, tick_spacing). The dynamic state
// (current tick, sqrt price, liquidity) is read at submit time via
// `useOrcaPoolState`.
//
// Devnet pools were probed live on api.devnet.solana.com on 2026-04-25
// to find ones with non-zero liquidity. The chosen pool is the
// highest-liquidity WSOL/USDC pair using the Circle devnet USDC mint
// that Cardo's bridge already targets.
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md
// (Family 3 — Orca Whirlpool swap; A1 → A0 promotion).

import type { Hex } from 'viem';
import { pubkeyBs58ToBytes32 } from './solana-pda';

export type OrcaPool = {
  /// Display label for the UI, e.g. "WSOL/USDC".
  label: string;
  /// Whirlpool account pubkey.
  whirlpool: Hex;
  /// Whirlpool config (parent of the pool — used by adaptive fee
  /// resolution; we just pass it through but currently don't pin it
  /// in the swap accounts list — kept for future swap_v2 wiring).
  whirlpoolsConfig: Hex;
  /// tick_spacing — affects tick_array address derivation. Read once
  /// from the on-chain pool struct (offset 41).
  tickSpacing: number;
  /// Token A mint (e.g., WSOL).
  tokenMintA: Hex;
  /// Pool's token A vault.
  tokenVaultA: Hex;
  /// Token B mint (e.g., USDC).
  tokenMintB: Hex;
  /// Pool's token B vault.
  tokenVaultB: Hex;
  /// Mint decimals (used for amount-encoding in swap calldata).
  tokenDecimalsA: number;
  tokenDecimalsB: number;
  /// Display labels for tokens A and B.
  symbolA: string;
  symbolB: string;
  /// Pool trade fee in Orca's native ppm (e.g. 300 = 0.03%). Drives the quote.
  feePpm: number;
  /// Whether this pool is currently enabled in the UI.
  enabled: boolean;
};

// ─────────────────────────────────────────────────────────────────────
// WSOL/USDC devnet pool — highest-liquidity match probed 2026-04-25
//
// Pool: 75cFnbvdn4ZXf5SoY4JMrY2PvWgb1FrxqGLw8NtaHwpE
// Liquidity: 140_141_217_044
// tick_spacing: 1, fee_rate: 300 (0.03%)
// ─────────────────────────────────────────────────────────────────────

// WSOL = token A (9dp), Circle devnet USDC = token B (6dp) — shared across all
// fee tiers below. Discovered live on the cluster (getProgramAccounts on the
// Orca program); these are the highest-liquidity WSOL/USDC whirlpools.
const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

function wsolUsdc(
  label: string,
  whirlpool: string,
  config: string,
  tickSpacing: number,
  feePpm: number,
  vaultA: string,
  vaultB: string,
): OrcaPool {
  return {
    label,
    whirlpool: pubkeyBs58ToBytes32(whirlpool),
    whirlpoolsConfig: pubkeyBs58ToBytes32(config),
    tickSpacing,
    tokenMintA: pubkeyBs58ToBytes32(WSOL),
    tokenVaultA: pubkeyBs58ToBytes32(vaultA),
    tokenMintB: pubkeyBs58ToBytes32(USDC),
    tokenVaultB: pubkeyBs58ToBytes32(vaultB),
    tokenDecimalsA: 9,
    tokenDecimalsB: 6,
    symbolA: 'WSOL',
    symbolB: 'USDC',
    feePpm,
    enabled: true,
  };
}

// Only pools verified to actually swap on-chain are listed (eth_call against
// each, 2026-06). Orca is concentrated-liquidity: a pool needs initialized tick
// arrays around the current price or the swap reverts (Custom(6036)). Of the 26
// WSOL/USDC whirlpools on the cluster, the 0.03% pool has dense liquidity (real
// sizes), the 0.2% is shallow (small swaps only — larger amounts revert safely),
// and the rest (0.05%, etc.) and all wETH pools are uninitialized → excluded.
export const ORCA_POOLS: ReadonlyArray<OrcaPool> = [
  // 0.03% — deepest (liq ~140B); handles real sizes.
  wsolUsdc('WSOL/USDC · 0.03%', '75cFnbvdn4ZXf5SoY4JMrY2PvWgb1FrxqGLw8NtaHwpE', 'J6Vz2BaM2pGUEYZndnERbk4oTrZmZ7ecJ8FxxzaojMu', 1, 300, 'HSjGRomWKRFF638kAf54t5tBag5A5g61SgSLXfbrsN2C', '3rtTxd4d564q2TVRP9znnoedNucRSQ9nkr1S5pyKpuYB'),
  // 0.2% — shallow (liq ~5.4B but thin initialized range); small swaps only.
  wsolUsdc('WSOL/USDC · 0.2%', 'EQ5KAPVdHvSP5aBqYos4vtEsZApx43iM9AnibexL4WYA', 'FcrweFY1G9HJAHG5inkGB6pKg1HZ6x9UC2WioAfWrGkR', 64, 2000, 'BDkgn98xVpAyAnSKUndY46TsV1CJZrFEsMao534EAgym', '581oW3VoK8VftLAvvRGQqHtcShn5Er1SHkQJ4JYGvgJW'),
];

export function findOrcaPoolByLabel(label: string): OrcaPool | undefined {
  return ORCA_POOLS.find((p) => p.label === label);
}

export const ENABLED_ORCA_POOLS: ReadonlyArray<OrcaPool> = ORCA_POOLS.filter(
  (p) => p.enabled,
);
