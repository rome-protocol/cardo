// Curated registry of Meteora DAMM v2 pools that Cardo /swap-meteora-v2
// supports. Each entry pins the constants needed by the swap adapter.
//
// Devnet pools probed live on api.devnet.solana.com on 2026-04-25.
// Pool struct offsets (after Anchor disc + PoolFeesStruct):
//   168: token_a_mint (32)
//   200: token_b_mint (32)
//   232: token_a_vault (32)
//   264: token_b_vault (32)
//   360: liquidity (u128)
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md

import type { Hex } from 'viem';
import { pubkeyBs58ToBytes32 } from './solana-pda';

export type DammV2Pool = {
  /// Display label.
  label: string;
  /// Pool account pubkey.
  pool: Hex;
  /// Token A mint (the smaller-numerically-sorted of the pair, but
  /// Meteora doesn't enforce sort order).
  tokenAMint: Hex;
  /// Pool's token A vault.
  tokenAVault: Hex;
  /// Token B mint.
  tokenBMint: Hex;
  /// Pool's token B vault.
  tokenBVault: Hex;
  /// Mint decimals.
  tokenADecimals: number;
  tokenBDecimals: number;
  /// Display labels.
  symbolA: string;
  symbolB: string;
  /// Token program for each side. SPL Token classic for canonical
  /// Circle USDC + WSOL on devnet. Token-2022 mints would pass T22.
  tokenAProgram: Hex;
  tokenBProgram: Hex;
  /// Whether this pool is currently enabled in the UI.
  enabled: boolean;
};

const SPL_TOKEN_PROGRAM = pubkeyBs58ToBytes32(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
);

// ─────────────────────────────────────────────────────────────────────
// WSOL/USDC devnet pool — highest-liquidity match probed 2026-04-25.
// pool: 7GaMagsYRFmTur6ZpNYv3P2V1z6aa31jqoTmzuVR2PPp
// liquidity: 64_880_008_903_313_935_161_897_527_313 (huge concentrated
// range)
// ─────────────────────────────────────────────────────────────────────

const DEVNET_WSOL_USDC: DammV2Pool = {
  label: 'WSOL / USDC (Meteora DAMM v2 devnet)',
  pool: pubkeyBs58ToBytes32('7GaMagsYRFmTur6ZpNYv3P2V1z6aa31jqoTmzuVR2PPp'),
  tokenAMint: pubkeyBs58ToBytes32(
    'So11111111111111111111111111111111111111112',
  ),
  tokenAVault: pubkeyBs58ToBytes32(
    'BVRaeZZZE4ZnNZDfat5hynAJksWV4YLXW6FwV2brn98f',
  ),
  tokenBMint: pubkeyBs58ToBytes32(
    '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  ),
  tokenBVault: pubkeyBs58ToBytes32(
    '4jWxNhRJbGC8safUp5Ak8Tt7PhMLHDHjADQ9wfTWMvsJ',
  ),
  tokenADecimals: 9,
  tokenBDecimals: 6,
  symbolA: 'WSOL',
  symbolB: 'USDC',
  tokenAProgram: SPL_TOKEN_PROGRAM,
  tokenBProgram: SPL_TOKEN_PROGRAM,
  enabled: true,
};

export const DAMM_V2_POOLS: ReadonlyArray<DammV2Pool> = [DEVNET_WSOL_USDC];

export const ENABLED_DAMM_V2_POOLS: ReadonlyArray<DammV2Pool> = DAMM_V2_POOLS.filter(
  (p) => p.enabled,
);
