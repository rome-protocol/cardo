// Raydium CLMM swap_v2 invoke builder.
//
// Per the IDL + verified by decoding sig hWTtod… on devnet 2026-04-26,
// `swap_v2` takes 13 fixed accounts in this order:
//
//   0.  payer                        (signer, writable)   ← user PDA
//   1.  amm_config                   (readonly)           ← per-pool config
//   2.  pool_state                   (writable)
//   3.  input_token_account          (writable)           ← user's ATA for input mint
//   4.  output_token_account         (writable)           ← user's ATA for output mint
//   5.  input_vault                  (writable)           ← pool vault for input mint
//   6.  output_vault                 (writable)           ← pool vault for output mint
//   7.  observation_state            (writable)
//   8.  token_program                (readonly)           ← classic SPL
//   9.  token_program_2022           (readonly)
//   10. memo_program                 (readonly)
//   11. input_vault_mint             (readonly)
//   12. output_vault_mint            (readonly)
//
// Then `remaining_accounts` (writable, no signer):
//   13. tick_array_bitmap_extension  (W)   ← always passed
//   14..N. tick_array_state          (W)   ← one or more, in traversal order
//
// Args (after the 8-byte disc):
//   amount:                  u64  LE
//   other_amount_threshold:  u64  LE       ← `minimum_amount_out` for is_base_input=1
//   sqrt_price_limit_x64:    u128 LE       ← 0 = disable; uses MIN/MAX internally
//   is_base_input:           bool (u8)     ← 1 = exact-input (we always use this)
//
// Source: github.com/raydium-io/raydium-clmm,
// programs/amm/src/instructions/swap_v2.rs

import { concat, type Address, type Hex } from 'viem';
import type { AccountMeta } from './cpi-precompile';
import { deriveAta, deriveRomeUserPda, pubkeyBs58ToBytes32 } from './solana-pda';
import {
  RAYDIUM_CLMM_PROGRAM,
  SWAP_V2_DISC,
} from './raydium-clmm-program';
import {
  bitPosToStartIndex,
  deriveTickArray,
  deriveTickArrayBitmapExtension,
  tickArrayStartIndex,
} from './raydium-clmm-pdas';
import type { RaydiumClmmPoolEntry } from './raydium-clmm-pools';

// ─────────────────────────────────────────────────────────────────────
// Shared Solana program ids the swap_v2 ix references.
// ─────────────────────────────────────────────────────────────────────

const TOKEN_PROGRAM_HEX: Hex = pubkeyBs58ToBytes32(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
);
/// SPL Token-2022 program. Required as a fixed account on swap_v2 even
/// when neither side is Token-2022 — the program just won't CPI into it.
const TOKEN_2022_PROGRAM_HEX: Hex = pubkeyBs58ToBytes32(
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
);
/// SPL Memo program. Same story — required slot, not always called.
const MEMO_PROGRAM_HEX: Hex = pubkeyBs58ToBytes32(
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
);

function toU64Le(v: bigint): Hex {
  if (v < 0n || v > 0xffffffffffffffffn) {
    throw new Error(`u64 out of range: ${v}`);
  }
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v, 0);
  return ('0x' + b.toString('hex')) as Hex;
}

function toU128Le(v: bigint): Hex {
  if (v < 0n || v > (1n << 128n) - 1n) {
    throw new Error(`u128 out of range: ${v}`);
  }
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(v & 0xffffffffffffffffn, 0);
  b.writeBigUInt64LE(v >> 64n, 8);
  return ('0x' + b.toString('hex')) as Hex;
}

function toU8(v: number): Hex {
  if (v < 0 || v > 255) throw new Error(`u8 out of range: ${v}`);
  return ('0x' + v.toString(16).padStart(2, '0')) as Hex;
}

export type RaydiumClmmSwapAddresses = {
  user: Hex;
  poolAddress: Hex;
  ammConfig: Hex;
  inputMint: Hex;
  outputMint: Hex;
  inputVault: Hex;
  outputVault: Hex;
  inputTokenProgram: Hex;
  outputTokenProgram: Hex;
  userInputAta: Hex;
  userOutputAta: Hex;
  observationKey: Hex;
  bitmapExtension: Hex;
  /// All tick-array PDAs included as remaining_accounts, in the order
  /// they appear in the ix accounts list.
  tickArrays: Hex[];
};

export type RaydiumClmmSwapInvoke = {
  program: Hex;
  accounts: AccountMeta[];
  data: Hex;
  addresses: RaydiumClmmSwapAddresses;
};

/// Conservative tick-array seed list for swap_v2 remaining_accounts.
///
/// CLMM swap_v2 requires AT LEAST one tick-array per side of the
/// current tick the swap could plausibly traverse. For a single-step
/// swap (UI quote assumes constant liquidity), the current array is
/// sufficient. We pad with the immediate neighbor on the swap-direction
/// side so a small-but-not-tiny swap that crosses one boundary still
/// has the next array loaded.
///
/// For tiny test swaps (<<1% of liquidity range), only the current
/// tick-array is needed. Including extra arrays that don't yet exist
/// on-chain triggers Rome strict-mode "account not found" — so we only
/// pass the seeded current-tick array. Future improvement: simulate
/// the swap math to determine exactly which arrays to include.
export function tickArraySeedList(
  pool: RaydiumClmmPoolEntry,
): { startIndex: number; bs58: string }[] {
  const startIdx = bitPosToStartIndex(pool.seededBitPos, pool.tickSpacing);
  // Resolve PDA in bs58 form for downstream use.
  // We just need the Hex form for the AccountMeta — bs58 is computed
  // by the page if needed.
  return [{ startIndex: startIdx, bs58: '' }];
}

/// Build a `swap_v2` invoke against a Raydium CLMM pool.
///
/// `inputIsToken0` selects which side the user is spending. The pool
/// itself is symmetric — `swap_v2` reads the input/output side from
/// accounts + the `is_base_input` flag — so we shuffle accounts.
///
/// `sqrtPriceLimitX64` defaults to 0 (no price-limit). The on-chain
/// program clamps to MIN/MAX_SQRT_PRICE in that case. Slippage is
/// enforced via `minimumAmountOut`.
export function buildRaydiumClmmSwapV2Invoke(args: {
  userEvmAddress: Address;
  pool: RaydiumClmmPoolEntry;
  /// `true` = user spends token_0 (WSOL on the seeded pool).
  /// `false` = user spends token_1 (USDC on the seeded pool).
  inputIsToken0: boolean;
  /// Exact input amount, mint smallest unit.
  amountIn: bigint;
  /// Slippage guard (`other_amount_threshold` with is_base_input=1).
  /// Program reverts if realized output is below this.
  minimumAmountOut: bigint;
  /// Optional price-limit guard. 0 = disable (default; UI always passes 0).
  sqrtPriceLimitX64?: bigint;
  /// LIVE pool tick_current (from pool state). When supplied, the tick
  /// array is derived from the CURRENT tick instead of the static registry
  /// `seededBitPos` — the static array goes stale the moment the pool's
  /// tick drifts out of its [start, start+spacing*60) window, the #1 cause
  /// of "Raydium CLMM swap reverted" on a pool that has traded. Falls back
  /// to seededBitPos only when a live tick isn't available.
  tickCurrent?: number;
}): RaydiumClmmSwapInvoke {
  const user = deriveRomeUserPda(args.userEvmAddress);
  const sqrtPriceLimit =
    args.sqrtPriceLimitX64 === undefined ? 0n : args.sqrtPriceLimitX64;

  const inputMint = args.inputIsToken0
    ? args.pool.token0Mint
    : args.pool.token1Mint;
  const outputMint = args.inputIsToken0
    ? args.pool.token1Mint
    : args.pool.token0Mint;
  const inputVault = args.inputIsToken0
    ? args.pool.token0Vault
    : args.pool.token1Vault;
  const outputVault = args.inputIsToken0
    ? args.pool.token1Vault
    : args.pool.token0Vault;
  const inputTokenProgram = args.inputIsToken0
    ? args.pool.token0Program
    : args.pool.token1Program;
  const outputTokenProgram = args.inputIsToken0
    ? args.pool.token1Program
    : args.pool.token0Program;

  // Caller-controlled user ATAs. `deriveAta` uses classic SPL Token —
  // fine for our seeded WSOL/USDC pool. Token-2022 pools join the
  // registry require an ATA-with-token-program derivation path; flag
  // when adding such a pool.
  const userInputAta = deriveAta(user, inputMint);
  const userOutputAta = deriveAta(user, outputMint);

  // Bitmap extension — always passed.
  const bitmapExt = deriveTickArrayBitmapExtension(args.pool.poolBs58);

  // Tick-array PDA. Derive the start index from the LIVE current tick when
  // the caller supplies it: the pool's tick drifts as it trades, so a
  // static registry seed goes stale and the swap reverts looking in the
  // wrong array. Fall back to `seededBitPos` only when no live tick is
  // available. The program walks the bitmap for the next array; one array
  // is enough for a tiny swap that doesn't cross a boundary.
  const tickArrayStart =
    args.tickCurrent === undefined
      ? bitPosToStartIndex(args.pool.seededBitPos, args.pool.tickSpacing)
      : tickArrayStartIndex(args.tickCurrent, args.pool.tickSpacing);
  const tickArrayPda = deriveTickArray(args.pool.poolBs58, tickArrayStart);

  const accounts: AccountMeta[] = [
    { pubkey: user, is_signer: true, is_writable: true },
    { pubkey: args.pool.ammConfig, is_signer: false, is_writable: false },
    { pubkey: args.pool.poolHex, is_signer: false, is_writable: true },
    { pubkey: userInputAta, is_signer: false, is_writable: true },
    { pubkey: userOutputAta, is_signer: false, is_writable: true },
    { pubkey: inputVault, is_signer: false, is_writable: true },
    { pubkey: outputVault, is_signer: false, is_writable: true },
    { pubkey: args.pool.observationKey, is_signer: false, is_writable: true },
    { pubkey: TOKEN_PROGRAM_HEX, is_signer: false, is_writable: false },
    { pubkey: TOKEN_2022_PROGRAM_HEX, is_signer: false, is_writable: false },
    { pubkey: MEMO_PROGRAM_HEX, is_signer: false, is_writable: false },
    { pubkey: inputMint, is_signer: false, is_writable: false },
    { pubkey: outputMint, is_signer: false, is_writable: false },
    // remaining_accounts:
    { pubkey: bitmapExt, is_signer: false, is_writable: true },
    { pubkey: tickArrayPda, is_signer: false, is_writable: true },
  ];

  const data = concat([
    SWAP_V2_DISC,
    toU64Le(args.amountIn),
    toU64Le(args.minimumAmountOut),
    toU128Le(sqrtPriceLimit),
    toU8(1), // is_base_input = true
  ]);

  return {
    program: RAYDIUM_CLMM_PROGRAM,
    accounts,
    data,
    addresses: {
      user,
      poolAddress: args.pool.poolHex,
      ammConfig: args.pool.ammConfig,
      inputMint,
      outputMint,
      inputVault,
      outputVault,
      inputTokenProgram,
      outputTokenProgram,
      userInputAta,
      userOutputAta,
      observationKey: args.pool.observationKey,
      bitmapExtension: bitmapExt,
      tickArrays: [tickArrayPda],
    },
  };
}
