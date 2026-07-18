// Orca Whirlpool swap instruction builder.
//
// The classic `swap` ix (SPL Token, not Token-2022). Single Solana ix,
// 11 accounts, single signer (the user's Rome PDA, which owns the
// source ATA). Tick arrays are derived at submit time from the pool's
// current tick + swap direction.
//
// Args layout (Anchor Borsh, 34 bytes):
//   amount                    u64 LE
//   other_amount_threshold    u64 LE
//   sqrt_price_limit          u128 LE
//   amount_specified_is_input bool
//   a_to_b                    bool
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md
// (Family 3 — Orca Whirlpool swap).

import { concat, numberToHex, type Address, type Hex } from 'viem';
import type { AccountMeta } from './cpi-precompile';
import {
  SPL_TOKEN_PROGRAM_ID,
  deriveAta,
  deriveRomeUserPda,
  pubkeyBs58ToBytes32,
  pubkeyToBytes32,
} from './solana-pda';
import { SWAP_DISC, WHIRLPOOL_PROGRAM } from './orca-program';
import {
  deriveOracle,
  deriveTickArray,
  tickArrayStartIndicesForSwap,
} from './orca-pdas';
import type { OrcaPool } from './orca-pools';

const SPL_TOKEN_PROGRAM_HEX = pubkeyToBytes32(SPL_TOKEN_PROGRAM_ID);

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

function toU128Le(value: bigint): Hex {
  if (
    value < 0n ||
    value > 0xffffffffffffffffffffffffffffffffn
  ) {
    throw new Error(`u128 out of range: ${value}`);
  }
  const beHex = numberToHex(value, { size: 16 }).slice(2);
  const bytes: string[] = [];
  for (let i = beHex.length; i > 0; i -= 2) bytes.push(beHex.slice(i - 2, i));
  return ('0x' + bytes.join('')) as Hex;
}

function toBool(b: boolean): Hex {
  return b ? '0x01' : '0x00';
}

// ─────────────────────────────────────────────────────────────────────
// Sqrt-price limit constants (Whirlpool program enforces these as
// hard min/max). Caller may pass tighter limits to control slippage.
// ─────────────────────────────────────────────────────────────────────

/// MAX_SQRT_PRICE_X64 from Orca SDK (sqrt(2^64 - 1) approximately).
/// Used as the upper bound for B → A swaps.
export const MAX_SQRT_PRICE_X64 = 79226673515401279992447579055n;

/// MIN_SQRT_PRICE_X64 from Orca SDK.
/// Used as the lower bound for A → B swaps.
export const MIN_SQRT_PRICE_X64 = 4295048016n;

// ─────────────────────────────────────────────────────────────────────
// Swap invoke builder
//
// IDL accounts (programs/whirlpool/src/instructions/swap.rs:6-48):
//   1. token_program           (readonly)
//   2. token_authority         (signer, readonly)  — user PDA
//   3. whirlpool               (writable)
//   4. token_owner_account_a   (writable)          — user's WSOL ATA
//   5. token_vault_a           (writable)          — pool's WSOL vault
//   6. token_owner_account_b   (writable)          — user's USDC ATA
//   7. token_vault_b           (writable)          — pool's USDC vault
//   8. tick_array_0            (writable)
//   9. tick_array_1            (writable)
//  10. tick_array_2            (writable)
//  11. oracle                  (readonly, PDA(["oracle", whirlpool]))
// ─────────────────────────────────────────────────────────────────────

export type OrcaSwapInvoke = {
  program: Hex;
  accounts: AccountMeta[];
  data: Hex;
  /// Echoed for the preview panel.
  addresses: {
    user: Hex;
    userAtaA: Hex;
    userAtaB: Hex;
    tickArrays: [Hex, Hex, Hex];
    oracle: Hex;
  };
};

export function buildOrcaSwapInvoke(args: {
  userEvmAddress: Address;
  pool: OrcaPool;
  /// Current tick read from the pool state at submit time.
  currentTick: number;
  /// Swap direction: A → B (e.g. WSOL → USDC) or B → A.
  aToB: boolean;
  /// Amount in smallest unit of the input token.
  amount: bigint;
  /// Slippage protection. When `amountSpecifiedIsInput=true`: minimum
  /// output. When false: maximum input. Pass 0 for "no slippage check"
  /// only when calldata is being verified, never for live txs.
  otherAmountThreshold: bigint;
  /// True = `amount` is the input quantity (default for "I want to
  /// spend X tokens"). False = output quantity ("I want to receive X").
  amountSpecifiedIsInput?: boolean;
  /// Tighter price-limit override; defaults to MIN/MAX based on direction.
  sqrtPriceLimit?: bigint;
}): OrcaSwapInvoke {
  const user = deriveRomeUserPda(args.userEvmAddress);
  const userAtaA = deriveAta(user, args.pool.tokenMintA);
  const userAtaB = deriveAta(user, args.pool.tokenMintB);

  const [start0, start1, start2] = tickArrayStartIndicesForSwap({
    currentTick: args.currentTick,
    tickSpacing: args.pool.tickSpacing,
    aToB: args.aToB,
  });
  const tickArray0 = deriveTickArray({
    whirlpool: args.pool.whirlpool,
    startTickIndex: start0,
  });
  const tickArray1 = deriveTickArray({
    whirlpool: args.pool.whirlpool,
    startTickIndex: start1,
  });
  const tickArray2 = deriveTickArray({
    whirlpool: args.pool.whirlpool,
    startTickIndex: start2,
  });
  const oracle = deriveOracle(args.pool.whirlpool);

  const accounts: AccountMeta[] = [
    { pubkey: SPL_TOKEN_PROGRAM_HEX, is_signer: false, is_writable: false },
    { pubkey: user, is_signer: true, is_writable: false },
    { pubkey: args.pool.whirlpool, is_signer: false, is_writable: true },
    { pubkey: userAtaA, is_signer: false, is_writable: true },
    { pubkey: args.pool.tokenVaultA, is_signer: false, is_writable: true },
    { pubkey: userAtaB, is_signer: false, is_writable: true },
    { pubkey: args.pool.tokenVaultB, is_signer: false, is_writable: true },
    { pubkey: tickArray0, is_signer: false, is_writable: true },
    { pubkey: tickArray1, is_signer: false, is_writable: true },
    { pubkey: tickArray2, is_signer: false, is_writable: true },
    { pubkey: oracle, is_signer: false, is_writable: false },
  ];

  const amountSpecifiedIsInput = args.amountSpecifiedIsInput ?? true;
  const sqrtPriceLimit =
    args.sqrtPriceLimit ?? (args.aToB ? MIN_SQRT_PRICE_X64 : MAX_SQRT_PRICE_X64);

  const data = concat([
    SWAP_DISC,
    toU64Le(args.amount),
    toU64Le(args.otherAmountThreshold),
    toU128Le(sqrtPriceLimit),
    toBool(amountSpecifiedIsInput),
    toBool(args.aToB),
  ]);

  return {
    program: WHIRLPOOL_PROGRAM,
    accounts,
    data,
    addresses: {
      user,
      userAtaA,
      userAtaB,
      tickArrays: [tickArray0, tickArray1, tickArray2],
      oracle,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// swap_v2 — Token-2022-aware swap. Verified vs upstream
// programs/whirlpool/src/instructions/v2/swap.rs (cross-checked
// 2026-04-26):
//
//   1.  token_program_a       (readonly) — Interface, classic or T22
//   2.  token_program_b       (readonly)
//   3.  memo_program          (readonly) — MemoSq4gqABAXKb96qnH8TysNc...
//   4.  token_authority       (signer, readonly) — user PDA
//   5.  whirlpool             (writable)
//   6.  token_mint_a          (readonly)
//   7.  token_mint_b          (readonly)
//   8.  token_owner_account_a (writable)
//   9.  token_vault_a         (writable)
//  10.  token_owner_account_b (writable)
//  11.  token_vault_b         (writable)
//  12.  tick_array_0          (writable)
//  13.  tick_array_1          (writable)
//  14.  tick_array_2          (writable)
//  15.  oracle                (writable — note: v1 had this readonly)
//
// Args layout is identical to v1's swap (34 bytes Borsh).
//
// Token-2022 mints with transfer hooks need additional
// `remaining_accounts`; this v1 builder doesn't pass them. For
// classic SPL pools (the only ones currently in our registry) the
// memo_program is unused but still required as an account meta.
// ─────────────────────────────────────────────────────────────────────

/// SPL Memo program v2 (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`).
/// Required as an account meta in swap_v2 even when no transfer hook
/// emits a memo — it's a static slot in the Anchor account list.
const MEMO_PROGRAM_HEX = pubkeyBs58ToBytes32(
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
);

/// `sha256("global:swap_v2")[..8]` — verified by `node -e ...`.
export const SWAP_V2_DISC: Hex = '0x2b04ed0b1ac91e62';

export function buildOrcaSwapV2Invoke(args: {
  userEvmAddress: Address;
  pool: OrcaPool;
  currentTick: number;
  aToB: boolean;
  amount: bigint;
  otherAmountThreshold: bigint;
  amountSpecifiedIsInput?: boolean;
  sqrtPriceLimit?: bigint;
  /// Token program for token A (defaults to classic SPL Token).
  /// Pass T22 program id for Token-2022 pools.
  tokenProgramAHex?: Hex;
  tokenProgramBHex?: Hex;
}): OrcaSwapInvoke {
  const user = deriveRomeUserPda(args.userEvmAddress);
  const userAtaA = deriveAta(user, args.pool.tokenMintA);
  const userAtaB = deriveAta(user, args.pool.tokenMintB);

  const [start0, start1, start2] = tickArrayStartIndicesForSwap({
    currentTick: args.currentTick,
    tickSpacing: args.pool.tickSpacing,
    aToB: args.aToB,
  });
  const tickArray0 = deriveTickArray({
    whirlpool: args.pool.whirlpool,
    startTickIndex: start0,
  });
  const tickArray1 = deriveTickArray({
    whirlpool: args.pool.whirlpool,
    startTickIndex: start1,
  });
  const tickArray2 = deriveTickArray({
    whirlpool: args.pool.whirlpool,
    startTickIndex: start2,
  });
  const oracle = deriveOracle(args.pool.whirlpool);

  const tokenProgramA = args.tokenProgramAHex ?? SPL_TOKEN_PROGRAM_HEX;
  const tokenProgramB = args.tokenProgramBHex ?? SPL_TOKEN_PROGRAM_HEX;

  const accounts: AccountMeta[] = [
    { pubkey: tokenProgramA, is_signer: false, is_writable: false },
    { pubkey: tokenProgramB, is_signer: false, is_writable: false },
    { pubkey: MEMO_PROGRAM_HEX, is_signer: false, is_writable: false },
    { pubkey: user, is_signer: true, is_writable: false },
    { pubkey: args.pool.whirlpool, is_signer: false, is_writable: true },
    { pubkey: args.pool.tokenMintA, is_signer: false, is_writable: false },
    { pubkey: args.pool.tokenMintB, is_signer: false, is_writable: false },
    { pubkey: userAtaA, is_signer: false, is_writable: true },
    { pubkey: args.pool.tokenVaultA, is_signer: false, is_writable: true },
    { pubkey: userAtaB, is_signer: false, is_writable: true },
    { pubkey: args.pool.tokenVaultB, is_signer: false, is_writable: true },
    { pubkey: tickArray0, is_signer: false, is_writable: true },
    { pubkey: tickArray1, is_signer: false, is_writable: true },
    { pubkey: tickArray2, is_signer: false, is_writable: true },
    { pubkey: oracle, is_signer: false, is_writable: true }, // note: writable in v2
  ];

  const amountSpecifiedIsInput = args.amountSpecifiedIsInput ?? true;
  const sqrtPriceLimit =
    args.sqrtPriceLimit ?? (args.aToB ? MIN_SQRT_PRICE_X64 : MAX_SQRT_PRICE_X64);

  const data = concat([
    SWAP_V2_DISC,
    toU64Le(args.amount),
    toU64Le(args.otherAmountThreshold),
    toU128Le(sqrtPriceLimit),
    toBool(amountSpecifiedIsInput),
    toBool(args.aToB),
  ]);

  return {
    program: WHIRLPOOL_PROGRAM,
    accounts,
    data,
    addresses: {
      user,
      userAtaA,
      userAtaB,
      tickArrays: [tickArray0, tickArray1, tickArray2],
      oracle,
    },
  };
}
