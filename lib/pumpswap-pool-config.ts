// PumpSwap active pool registry for Cardo `/swap-pumpswap`.
//
// The page targets one canonical pool per release. Swap to a different
// pool by editing this file; the screen + hook are pool-agnostic.
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md

import { pubkeyBs58ToBytes32 } from './solana-pda';
import { activeChain } from './chain-config';
import type { Hex } from 'viem';

export type PumpswapPoolConfig = {
  /// Pool account, bs58.
  poolBs58: string;
  /// Pool account, bytes32 (precomputed for the precompile call).
  poolHex: Hex;
  /// Token shown on the "base" side of the form (memecoin).
  base: {
    symbol: string;
    /// EVM ERC20-SPL wrapper on Rome.
    wrapper: `0x${string}`;
    /// Solana mint, bs58.
    mintBs58: string;
    decimals: number;
  };
  /// Token shown on the "quote" side of the form (typically WSOL).
  quote: {
    symbol: string;
    wrapper: `0x${string}`;
    mintBs58: string;
    decimals: number;
  };
};

/// Active pool: top liquid PumpSwap WSOL pair on Rome's devnet target
/// as of 2026-04-25. Built per Rome chain at call time (only the quote
/// wrapper is chain-specific); memoized so identity is hook-dep-stable.
///
/// Reserves (live at deploy time): 9_991_759_883.65 MEME / 1.001 WSOL.
/// Adapter library (lib/pumpswap-instructions.ts) is pool-agnostic; this
/// config just wires up the default page surface.
const poolByChain = new Map<number, PumpswapPoolConfig>();

export function pumpswapActivePool(chainId?: number): PumpswapPoolConfig {
  const chain = activeChain(chainId);
  let pool = poolByChain.get(chain.id);
  if (!pool) {
    pool = buildPool(chain.wrappers.wWsol);
    poolByChain.set(chain.id, pool);
  }
  return pool;
}

function buildPool(wWsolWrapper: `0x${string}`): PumpswapPoolConfig {
  return {
  poolBs58: 'Gv1G2iqECW7LBQvFX8RnVsL8EY8UbZphjbW9EziaeYB3',
  poolHex: pubkeyBs58ToBytes32(
    'Gv1G2iqECW7LBQvFX8RnVsL8EY8UbZphjbW9EziaeYB3',
  ),
  base: {
    symbol: 'WMEME',
    // MEME memecoin wrapper — Cardo-specific token, NOT in the registry
    // (no canonical entry). Stale pre-#240 address; balance reads are
    // mint-based so this is a display-only key. Needs its own cached
    // wrapper deploy + registry entry to be fully de-hardcoded.
    wrapper: '0xa5e4984052F4831Aad050e9863527829db1E7a56',
    mintBs58: '71pbvV4iNQnKZSvyf3a63yujVUrvuBatahmmZp9bJ9D',
    decimals: 9,
  },
  quote: {
    symbol: 'WWSOL',
    wrapper: wWsolWrapper, // registry-driven per Rome chain (was module-frozen to the boot default)
    mintBs58: 'So11111111111111111111111111111111111111112',
    decimals: 9,
  },
  };
}
