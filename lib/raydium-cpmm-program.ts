// Raydium CPMM (constant-product market maker) program constants for the
// Cardo `/swap-raydium` integration.
//
// **Source of truth**: github.com/raydium-io/raydium-cp-swap (`programs/cp-swap`).
// Discriminators below are sha256("global:<method>")[..8] (Anchor 0.x).
//
// Devnet bootstrap state (verified live 2026-04-25):
//   - Program (CPMDWBwJ…)               executable=true ✓
//   - 16,228 PoolState accounts on devnet
//   - Sole maintained USDC/WSOL pool: 2HyNe5a32uVoB4BybXCLak41QrejZLqF9hZM6KBMQ1V2
//     (auth_bump=255, status=0/open, 0.27 SOL + 0.027 USDC liquidity).
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md
// (Family 3, A1 → A0 promotion: program already on devnet, single pool
// served the bootstrap budget without auto-cloning).

import type { Hex } from 'viem';
import { pubkeyBs58ToBytes32 } from './solana-pda';
import { solanaProgramId } from './solana-programs';

// ─────────────────────────────────────────────────────────────────────
// Program id (from @rome-protocol/registry).
//
// Devnet ≠ mainnet. Mainnet is `CPMMoo8L…`, devnet uses Raydium's
// devnet redeploy `CPMDWBwJ…` — both tracked in registry.
// ─────────────────────────────────────────────────────────────────────

export const RAYDIUM_CPMM_PROGRAM: Hex = pubkeyBs58ToBytes32(
  solanaProgramId('raydiumCpmm', 'devnet'),
);

// ─────────────────────────────────────────────────────────────────────
// Anchor instruction discriminators
//
// Computed: sha256("global:<method>")[..8].
//   swap_base_input  = [143, 190, 90, 218, 196, 30, 51, 222]
//   swap_base_output = [55, 217, 98, 86, 163, 74, 180, 173]
// ─────────────────────────────────────────────────────────────────────

/// `swap_base_input` — user supplies an exact `amount_in`, receives
/// at-least `minimum_amount_out`. Standard "swap exact input" semantics.
export const SWAP_BASE_INPUT_DISC: Hex = '0x8fbe5adac41e33de';

/// `swap_base_output` — user receives an exact `amount_out`, supplies
/// at-most `max_amount_in`. Less common; we ship `swap_base_input` first.
export const SWAP_BASE_OUTPUT_DISC: Hex = '0x37d96256a34ab4ad';

// ─────────────────────────────────────────────────────────────────────
// PDA seeds
// ─────────────────────────────────────────────────────────────────────

/// Authority PDA seed. PDA(["vault_and_lp_mint_auth_seed"], program).
/// Single global PDA across the whole program (verified bump=255 against
/// devnet pool 2HyNe5a32u…'s `auth_bump` field).
export const AUTHORITY_SEED = Buffer.from('vault_and_lp_mint_auth_seed');

// ─────────────────────────────────────────────────────────────────────
// Pool account
// ─────────────────────────────────────────────────────────────────────

/// IDL discriminator for `PoolState`. Used in `getProgramAccounts`
/// memcmp filter to enumerate pools.
///   sha256("account:PoolState")[..8] = [247,237,227,245,215,195,222,70]
export const POOL_DISC: number[] = [247, 237, 227, 245, 215, 195, 222, 70];

/// On-chain size of a PoolState account (bytes), per the IDL layout:
/// 8 disc + 9×32 pubkey + 1+1+1+1+1 flags/decimals + 8 lp_supply +
/// 4×8 fee accumulators + 8 open_time + 8 recent_epoch + 31×8 padding.
/// Live devnet pool reports 637.
export const POOL_SIZE = 637;

// ─────────────────────────────────────────────────────────────────────
// AmmConfig account
// ─────────────────────────────────────────────────────────────────────

/// `sha256("account:AmmConfig")[..8]`. Not used today (we pin AmmConfig
/// per-pool from the PoolState struct), but published so future bootstrap
/// scripts can enumerate configs.
export const AMM_CONFIG_DISC: number[] = [218, 244, 33, 104, 203, 203, 43, 111];

// ─────────────────────────────────────────────────────────────────────
// CU budget (empirical estimate; CPMM swap is ~13 accounts and touches
// pool + 2 vaults + observation update).
// ─────────────────────────────────────────────────────────────────────

export const CU_RAYDIUM_CPMM_SWAP = 80_000n;
