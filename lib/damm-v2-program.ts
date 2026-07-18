// Meteora DAMM v2 (cp-amm) program constants for Cardo /swap-meteora-v2.
//
// **Source of truth**: github.com/MeteoraAg/damm-v2 (Anchor program).
// All discriminators below are sha256("global:<method>")[..8].
//
// Devnet: program at `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` (same
// as mainnet) — 19,588 active pools, 4 funded WSOL/USDC pairs probed
// 2026-04-25.
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md
// (Family 3 — A1 → A0 promotion via existing devnet liquidity).

import type { Hex } from 'viem';
import { pubkeyBs58ToBytes32 } from './solana-pda';
import { solanaProgramId } from './solana-programs';

/// DAMM v2 (cp-amm) program (from @rome-protocol/registry).
/// Mainnet has it; devnet doesn't (registry maps it under meteoraDammV2).
export const DAMM_V2_PROGRAM: Hex = pubkeyBs58ToBytes32(
  solanaProgramId('meteoraDammV2', 'mainnet'),
);

/// Pool authority — fixed PDA per the program. Hardcoded per
/// `const_pda::pool_authority::ID`. Verified via the program test:
/// `HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC`.
export const DAMM_V2_POOL_AUTHORITY: Hex = pubkeyBs58ToBytes32(
  'HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC',
);

/// Anchor disc for `swap` (the simple SwapParameters variant, not swap2).
/// sha256("global:swap")[..8].
export const SWAP_DISC: Hex = '0xf8c69e91e17587c8';

/// `add_liquidity` — sha256("global:add_liquidity")[..8] verified.
export const ADD_LIQUIDITY_DISC: Hex = '0xb59d59438fb63448';

/// `remove_liquidity` — sha256("global:remove_liquidity")[..8] verified.
export const REMOVE_LIQUIDITY_DISC: Hex = '0x5055d14818ceb16c';

/// Event authority PDA seed (Anchor `#[event_cpi]` macro).
/// PDA(["__event_authority"], program_id).
export const EVENT_AUTHORITY_SEED = Buffer.from('__event_authority');

/// Position PDA seed: PDA([b"position", positionNftMint], DAMM_V2_PROGRAM).
/// Verified vs cp-amm/src/constants.rs `POSITION_PREFIX = b"position"`.
export const POSITION_SEED = Buffer.from('position');

// CU budget (empirical estimate, conservative; DAMM v2 swaps are
// constant-product-style with concentrated-liquidity range — single
// pool ix, no tick array iteration).
export const CU_SWAP = 100_000n;
export const CU_ADD_LIQUIDITY = 80_000n;
export const CU_REMOVE_LIQUIDITY = 100_000n;
