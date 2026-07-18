// SPL Stake Pool program constants for the Cardo /stake integration.
//
// **Source of truth: github.com/solana-labs/solana-program-library**
// Specifically:
//   stake-pool/program/src/instruction.rs   — instruction enum (bincode-tagged)
//   stake-pool/program/src/processor.rs     — per-instruction account orderings
//   stake-pool/program/src/state.rs         — StakePool struct layout
//
// Unlike Anchor programs (Kamino, Drift, Meteora), spl-stake-pool uses
// **bincode-style enum-tagged instructions**. There is no
// `sha256("global:<name>")[..8]` discriminator. The instruction data
// layout is: `u8(tag) || borsh-encoded args` where `tag` is the variant
// index in the `StakePoolInstruction` enum.
//
// Most production LSTs (JitoSOL, jupSOL, bSOL, dSOL, jSOL, Phantom SOL,
// Edgevana SOL, etc.) deploy the **stock spl-stake-pool program** at
// `SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy`. Each LST is a separate
// `StakePool` PDA + `ValidatorList` PDA + `pool_mint` SPL mint, but they
// all share the same on-chain code.
//
// Custom programs (Marinade's MarBmsSg…, Sanctum's stkitrT1…) have
// different ABIs and need their own adapters — see
// `lib/marinade-instructions.ts` (planned) and `lib/sanctum-instructions.ts`
// (planned). This file is for the stock spl-stake-pool ABI only.
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md
// (Family 1, Phase A — Sprint 1).

import type { Hex } from 'viem';
import { pubkeyBs58ToBytes32 } from './solana-pda';
import { solanaProgramId } from './solana-programs';

// ─────────────────────────────────────────────────────────────────────
// Program ids (from @rome-protocol/registry)
// ─────────────────────────────────────────────────────────────────────

/// Stock SPL stake-pool program. Same on devnet + mainnet.
export const SPL_STAKE_POOL_PROGRAM: Hex = pubkeyBs58ToBytes32(
  solanaProgramId('stakePool', 'devnet'),
);

/// Native SOL stake program (referenced by stake-pool's withdraw authority
/// derivation; not directly invoked from DepositSol).
export const STAKE_PROGRAM: Hex = pubkeyBs58ToBytes32(
  'Stake11111111111111111111111111111111111111',
);

// ─────────────────────────────────────────────────────────────────────
// Instruction tags (bincode enum variant indices)
//
// Verified against
// https://github.com/solana-labs/solana-program-library/blob/master/stake-pool/program/src/instruction.rs#L26-L320
// ─────────────────────────────────────────────────────────────────────

export const STAKE_POOL_TAG_DEPOSIT_SOL = 14;
export const STAKE_POOL_TAG_WITHDRAW_SOL = 16;
export const STAKE_POOL_TAG_DEPOSIT_SOL_WITH_SLIPPAGE = 24;
export const STAKE_POOL_TAG_WITHDRAW_SOL_WITH_SLIPPAGE = 25;

// ─────────────────────────────────────────────────────────────────────
// PDA seed constants
// (see stake-pool/program/src/state.rs and processor.rs derivations)
// ─────────────────────────────────────────────────────────────────────

/// Seed for the stake-pool's withdraw authority PDA:
///   PDA([stake_pool, "withdraw"], SPL_STAKE_POOL_PROGRAM)
export const WITHDRAW_AUTHORITY_SEED = Buffer.from('withdraw');

// ─────────────────────────────────────────────────────────────────────
// CU budgets (empirical, mainnet-fork measurements pending — these are
// upstream-documented + community-observed bands).
//
// DepositSol on a healthy pool: ~25-50K CU including the inner
// system_program::transfer.
// ─────────────────────────────────────────────────────────────────────

export const CU_DEPOSIT_SOL = 50_000n;
export const CU_WITHDRAW_SOL = 70_000n;
