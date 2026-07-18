// Drift v2 program constants for Cardo /perps + /lend (Drift Spot leg).
//
// **Source of truth**: github.com/drift-labs/protocol-v2 + their
// published IDL at sdk/src/idl/drift.json.
//
// Devnet: program at `dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH`
// (same as mainnet) — 6,974 active accounts, full bootstrap state
// including 9 spot markets and a maintained State PDA.
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md
// (Family 5 — Drift Spot first; perps later).

import type { Hex } from 'viem';
import { pubkeyBs58ToBytes32 } from './solana-pda';
import { solanaProgramId } from './solana-programs';

/// Drift v2 program (from @rome-protocol/registry). Same on devnet + mainnet.
export const DRIFT_PROGRAM: Hex = pubkeyBs58ToBytes32(
  solanaProgramId('driftV2', 'devnet'),
);

/// Anchor discriminators — `sha256("global:<rust_snake_case_name>")[..8]`.
///
/// **Anchor's discriminator hashes the RUST function name** (which is
/// snake_case for Drift's `initialize_user`, `initialize_user_stats`),
/// NOT the camelCase form that appears in the IDL JSON.
///
/// Verified by decoding real successful Drift deposit + init txs on
/// devnet (sig `45JCSgcH…`, slot 456332030):
///   `initialize_user_stats` ix data starts with fef34862fb82a8d5 ✓
///   `initialize_user`       ix data starts with 6f11b9fa3c7a26fe ✓
///   `deposit`               ix data starts with f223c68952e1f2b6 ✓
///
/// (`deposit` and `withdraw` happen to have no underscore, so the
/// snake_case and camelCase forms produce identical hashes.)
export const INITIALIZE_USER_DISC: Hex = '0x6f11b9fa3c7a26fe';
export const INITIALIZE_USER_STATS_DISC: Hex = '0xfef34862fb82a8d5';
export const DEPOSIT_DISC: Hex = '0xf223c68952e1f2b6';
export const WITHDRAW_DISC: Hex = '0xb712469c946da122';

// ─────────────────────────────────────────────────────────────────────
// PDA seeds
// ─────────────────────────────────────────────────────────────────────

export const DRIFT_STATE_SEED = Buffer.from('drift_state');
export const USER_SEED = Buffer.from('user');
export const USER_STATS_SEED = Buffer.from('user_stats');
export const SPOT_MARKET_SEED = Buffer.from('spot_market');
export const DRIFT_SIGNER_SEED = Buffer.from('drift_signer');

// CU budget (empirical). Drift's deposit reads/writes ~7 accounts plus
// spot market vault — single ix, atomic. 100K is conservative.
export const CU_INITIALIZE_USER = 60_000n;
export const CU_INITIALIZE_USER_STATS = 40_000n;
export const CU_DEPOSIT = 100_000n;
export const CU_WITHDRAW = 100_000n;
