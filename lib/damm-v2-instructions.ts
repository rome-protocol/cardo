// Meteora DAMM v2 swap instruction builder.
//
// Single Solana ix, 14 accounts (12 fixed + event_authority + program;
// referral_token_account is `Option` but gets pinned to the program id
// when None per Anchor's Optional convention). One signer (the user's
// Rome PDA — payer of the swap, owner of the input ATA).
//
// Args layout (Anchor Borsh, 16 bytes):
//   amount_in           u64 LE
//   minimum_amount_out  u64 LE
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md
// (Family 3 — Meteora DAMM v2 swap).

import { concat, numberToHex, type Address, type Hex } from 'viem';
import type { AccountMeta } from './cpi-precompile';
import { deriveAta, deriveRomeUserPda } from './solana-pda';
import {
  ADD_LIQUIDITY_DISC,
  DAMM_V2_POOL_AUTHORITY,
  DAMM_V2_PROGRAM,
  REMOVE_LIQUIDITY_DISC,
  SWAP_DISC,
} from './damm-v2-program';
import {
  deriveDammV2EventAuthority,
  deriveDammV2Position,
} from './damm-v2-pdas';
import type { DammV2Pool } from './damm-v2-pools';
import { pubkeyBs58ToBytes32, pubkeyToBytes32 } from './solana-pda';
import { SPL_TOKEN_PROGRAM_ID } from './solana-pda';

// ─────────────────────────────────────────────────────────────────────
// Encoding helpers (mirror Sprint 1 conventions)
// ─────────────────────────────────────────────────────────────────────

function toU64Le(value: bigint): Hex {
  if (value < 0n || value > 0xffffffffffffffffn) {
    throw new Error(`u64 out of range: ${value}`);
  }
  const beHex = numberToHex(value, { size: 8 }).slice(2);
  const bytes: string[] = [];
  for (let i = beHex.length; i > 0; i -= 2) bytes.push(beHex.slice(i - 2, i));
  return ('0x' + bytes.join('')) as Hex;
}

// ─────────────────────────────────────────────────────────────────────
// Swap invoke builder
//
// IDL accounts (programs/cp-amm/src/instructions/swap/ix_swap.rs:55-100):
//   1. pool_authority         (readonly, fixed PDA)
//   2. pool                   (writable)
//   3. input_token_account    (writable)  — user's ATA for input mint
//   4. output_token_account   (writable)  — user's ATA for output mint
//   5. token_a_vault          (writable)
//   6. token_b_vault          (writable)
//   7. token_a_mint           (readonly)
//   8. token_b_mint           (readonly)
//   9. payer                  (signer)    — user's Rome PDA
//  10. token_a_program        (readonly)
//  11. token_b_program        (readonly)
//  12. referral_token_account (writable, Option) — pass program id for None
//  13. event_authority        (readonly, PDA(["__event_authority"], DAMM_V2))
//  14. program                (readonly)  — DAMM_V2_PROGRAM itself
// ─────────────────────────────────────────────────────────────────────

export type DammV2SwapInvoke = {
  program: Hex;
  accounts: AccountMeta[];
  data: Hex;
  /// Echoed for the preview panel.
  addresses: { user: Hex; userInputAta: Hex; userOutputAta: Hex; eventAuthority: Hex };
};

export function buildDammV2SwapInvoke(args: {
  userEvmAddress: Address;
  pool: DammV2Pool;
  /// Direction: A → B (e.g. WSOL → USDC) or B → A.
  aToB: boolean;
  /// Amount in smallest unit of the input token.
  amountIn: bigint;
  /// Slippage protection — minimum output in smallest unit. Pass 0n
  /// for "no slippage check" (testing only).
  minimumAmountOut: bigint;
}): DammV2SwapInvoke {
  const user = deriveRomeUserPda(args.userEvmAddress);

  const inputMint = args.aToB ? args.pool.tokenAMint : args.pool.tokenBMint;
  const outputMint = args.aToB ? args.pool.tokenBMint : args.pool.tokenAMint;
  const userInputAta = deriveAta(user, inputMint);
  const userOutputAta = deriveAta(user, outputMint);

  const eventAuthority = deriveDammV2EventAuthority();

  const accounts: AccountMeta[] = [
    { pubkey: DAMM_V2_POOL_AUTHORITY, is_signer: false, is_writable: false },
    { pubkey: args.pool.pool, is_signer: false, is_writable: true },
    { pubkey: userInputAta, is_signer: false, is_writable: true },
    { pubkey: userOutputAta, is_signer: false, is_writable: true },
    { pubkey: args.pool.tokenAVault, is_signer: false, is_writable: true },
    { pubkey: args.pool.tokenBVault, is_signer: false, is_writable: true },
    { pubkey: args.pool.tokenAMint, is_signer: false, is_writable: false },
    { pubkey: args.pool.tokenBMint, is_signer: false, is_writable: false },
    { pubkey: user, is_signer: true, is_writable: false }, // payer = Rome PDA
    { pubkey: args.pool.tokenAProgram, is_signer: false, is_writable: false },
    { pubkey: args.pool.tokenBProgram, is_signer: false, is_writable: false },
    // referral_token_account is Optional. Anchor's Optional sentinel
    // for None is the program id itself — pass DAMM_V2_PROGRAM.
    { pubkey: DAMM_V2_PROGRAM, is_signer: false, is_writable: false },
    { pubkey: eventAuthority, is_signer: false, is_writable: false },
    { pubkey: DAMM_V2_PROGRAM, is_signer: false, is_writable: false },
  ];

  const data = concat([
    SWAP_DISC,
    toU64Le(args.amountIn),
    toU64Le(args.minimumAmountOut),
  ]);

  return {
    program: DAMM_V2_PROGRAM,
    accounts,
    data,
    addresses: { user, userInputAta, userOutputAta, eventAuthority },
  };
}

// ─────────────────────────────────────────────────────────────────────
// LP — add_liquidity / remove_liquidity
//
// Both ix require the user to already hold a Position NFT (created
// elsewhere — `create_position` ix requires an ephemeral keypair signer
// for the NFT mint, blocked by Rome Track B). Caller passes the position
// NFT mint pubkey; we derive the Position PDA + user's NFT ATA.
//
// add_liquidity accounts (12, verified vs cp-amm/instructions/ix_add_liquidity.rs):
//   1.  pool                  (mut)
//   2.  position              (mut, has_one pool)
//   3.  token_a_account       (mut) — user's ATA for tokenAMint
//   4.  token_b_account       (mut) — user's ATA for tokenBMint
//   5.  token_a_vault         (mut)
//   6.  token_b_vault         (mut)
//   7.  token_a_mint          (ro)
//   8.  token_b_mint          (ro)
//   9.  position_nft_account  (ro) — user's ATA for the position NFT
//   10. owner                 (signer) — user's Rome PDA
//   11. token_a_program       (ro)
//   12. token_b_program       (ro)
//
// remove_liquidity adds pool_authority (ro) at the front, +1 = 13
// accounts.
//
// add_liquidity args (Borsh): liquidity_delta u128 || token_a_amount_threshold u64 || token_b_amount_threshold u64
// remove_liquidity args:      Option<u128>      || token_a_amount_threshold u64 || token_b_amount_threshold u64
// ─────────────────────────────────────────────────────────────────────

const SPL_TOKEN_PROGRAM_HEX = pubkeyToBytes32(SPL_TOKEN_PROGRAM_ID);

function toU128Le(value: bigint): Hex {
  if (value < 0n || value > 0xffffffffffffffffffffffffffffffffn) {
    throw new Error(`u128 out of range: ${value}`);
  }
  const beHex = numberToHex(value, { size: 16 }).slice(2);
  const bytes: string[] = [];
  for (let i = beHex.length; i > 0; i -= 2) bytes.push(beHex.slice(i - 2, i));
  return ('0x' + bytes.join('')) as Hex;
}

export type DammV2LpAddresses = {
  user: Hex;
  position: Hex;
  positionNftAccount: Hex;
  userAtaA: Hex;
  userAtaB: Hex;
};

export type DammV2LpInvoke = {
  program: Hex;
  accounts: AccountMeta[];
  data: Hex;
  addresses: DammV2LpAddresses;
};

export function buildDammV2AddLiquidityInvoke(args: {
  userEvmAddress: Address;
  pool: DammV2Pool;
  /// Position NFT mint pubkey (bytes32 hex). User must already hold the
  /// position NFT — see header note about Track B for create_position.
  positionNftMintHex: Hex;
  /// Liquidity to add (u128).
  liquidityDelta: bigint;
  /// Slippage upper-bounds — caller's max for token A / B contribution.
  tokenAAmountThreshold: bigint;
  tokenBAmountThreshold: bigint;
  /// Optional override for per-side token program (defaults to classic SPL).
  tokenAProgramHex?: Hex;
  tokenBProgramHex?: Hex;
}): DammV2LpInvoke {
  const user = deriveRomeUserPda(args.userEvmAddress);
  const position = deriveDammV2Position(args.positionNftMintHex);
  const positionNftAccount = deriveAta(user, args.positionNftMintHex);
  const userAtaA = deriveAta(user, args.pool.tokenAMint);
  const userAtaB = deriveAta(user, args.pool.tokenBMint);
  const tokenAProgram = args.tokenAProgramHex ?? SPL_TOKEN_PROGRAM_HEX;
  const tokenBProgram = args.tokenBProgramHex ?? SPL_TOKEN_PROGRAM_HEX;

  const accounts: AccountMeta[] = [
    { pubkey: args.pool.pool, is_signer: false, is_writable: true },
    { pubkey: position, is_signer: false, is_writable: true },
    { pubkey: userAtaA, is_signer: false, is_writable: true },
    { pubkey: userAtaB, is_signer: false, is_writable: true },
    { pubkey: args.pool.tokenAVault, is_signer: false, is_writable: true },
    { pubkey: args.pool.tokenBVault, is_signer: false, is_writable: true },
    { pubkey: args.pool.tokenAMint, is_signer: false, is_writable: false },
    { pubkey: args.pool.tokenBMint, is_signer: false, is_writable: false },
    { pubkey: positionNftAccount, is_signer: false, is_writable: false },
    { pubkey: user, is_signer: true, is_writable: false },
    { pubkey: tokenAProgram, is_signer: false, is_writable: false },
    { pubkey: tokenBProgram, is_signer: false, is_writable: false },
  ];

  const data = concat([
    ADD_LIQUIDITY_DISC,
    toU128Le(args.liquidityDelta),
    toU64Le(args.tokenAAmountThreshold),
    toU64Le(args.tokenBAmountThreshold),
  ]);

  return {
    program: DAMM_V2_PROGRAM,
    accounts,
    data,
    addresses: { user, position, positionNftAccount, userAtaA, userAtaB },
  };
}

export function buildDammV2RemoveLiquidityInvoke(args: {
  userEvmAddress: Address;
  pool: DammV2Pool;
  positionNftMintHex: Hex;
  /// Liquidity to remove. Pass null to redeem the full position.
  liquidityDelta: bigint | null;
  /// Slippage lower-bounds — caller's min for token A / B return.
  tokenAAmountThreshold: bigint;
  tokenBAmountThreshold: bigint;
  tokenAProgramHex?: Hex;
  tokenBProgramHex?: Hex;
}): DammV2LpInvoke {
  const user = deriveRomeUserPda(args.userEvmAddress);
  const position = deriveDammV2Position(args.positionNftMintHex);
  const positionNftAccount = deriveAta(user, args.positionNftMintHex);
  const userAtaA = deriveAta(user, args.pool.tokenAMint);
  const userAtaB = deriveAta(user, args.pool.tokenBMint);
  const tokenAProgram = args.tokenAProgramHex ?? SPL_TOKEN_PROGRAM_HEX;
  const tokenBProgram = args.tokenBProgramHex ?? SPL_TOKEN_PROGRAM_HEX;

  // remove_liquidity adds pool_authority at index 0.
  const accounts: AccountMeta[] = [
    { pubkey: DAMM_V2_POOL_AUTHORITY, is_signer: false, is_writable: false },
    { pubkey: args.pool.pool, is_signer: false, is_writable: true },
    { pubkey: position, is_signer: false, is_writable: true },
    { pubkey: userAtaA, is_signer: false, is_writable: true },
    { pubkey: userAtaB, is_signer: false, is_writable: true },
    { pubkey: args.pool.tokenAVault, is_signer: false, is_writable: true },
    { pubkey: args.pool.tokenBVault, is_signer: false, is_writable: true },
    { pubkey: args.pool.tokenAMint, is_signer: false, is_writable: false },
    { pubkey: args.pool.tokenBMint, is_signer: false, is_writable: false },
    { pubkey: positionNftAccount, is_signer: false, is_writable: false },
    { pubkey: user, is_signer: true, is_writable: false },
    { pubkey: tokenAProgram, is_signer: false, is_writable: false },
    { pubkey: tokenBProgram, is_signer: false, is_writable: false },
  ];

  // Borsh Option<u128>: 1 byte tag (0=None, 1=Some) + 16 bytes if Some.
  const liquidityOpt: Hex =
    args.liquidityDelta === null
      ? '0x00'
      : (('0x01' + toU128Le(args.liquidityDelta).slice(2)) as Hex);

  const data = concat([
    REMOVE_LIQUIDITY_DISC,
    liquidityOpt,
    toU64Le(args.tokenAAmountThreshold),
    toU64Le(args.tokenBAmountThreshold),
  ]);

  return {
    program: DAMM_V2_PROGRAM,
    accounts,
    data,
    addresses: { user, position, positionNftAccount, userAtaA, userAtaB },
  };
}
