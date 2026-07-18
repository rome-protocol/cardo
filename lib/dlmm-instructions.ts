// Meteora DLMM `swap` invoke builder.
//
// Per the published IDL (idls/dlmm.json v0.10.1, fetched 2026-04-26),
// the `swap` ix takes 14 fixed accounts in this order, plus `remaining_accounts`:
//
//   0.  lb_pair                       (writable)
//   1.  bin_array_bitmap_extension    (readonly, OPTIONAL — pass program id when N/A)
//   2.  reserve_x                     (writable)
//   3.  reserve_y                     (writable)
//   4.  user_token_in                 (writable, user's source ATA)
//   5.  user_token_out                (writable, user's dest ATA)
//   6.  token_x_mint                  (readonly)
//   7.  token_y_mint                  (readonly)
//   8.  oracle                        (writable)
//   9.  host_fee_in                   (writable, OPTIONAL — pass program id when N/A)
//   10. user                          (signer = user's Rome PDA)
//   11. token_x_program               (readonly)
//   12. token_y_program               (readonly)
//   13. event_authority               (PDA, readonly)
//   14. program                       (DLMM program id, readonly)
//
// Then `remaining_accounts` (writable):
//   15..N. bin_array_state            (writable, in traversal order)
//
// Args (after the 8-byte disc):
//   amount_in:        u64 LE
//   min_amount_out:   u64 LE
//
// Source: github.com/MeteoraAg/dlmm-sdk, programs/lb_clmm/src/instructions/swap.rs
//
// Anchor "optional" account convention: pass the program ID itself in
// place of the optional account when not using it. We use that for
// `bin_array_bitmap_extension` (pool fits in inline bitmap) and
// `host_fee_in` (no host fee referrer for our flow).

import { concat, type Address, type Hex } from 'viem';
import type { AccountMeta } from './cpi-precompile';
import { deriveAta, deriveRomeUserPda } from './solana-pda';
import {
  DLMM_PROGRAM,
  SWAP_DISC,
} from './dlmm-program';
import {
  binArrayIndexForBinId,
  deriveBinArray,
  deriveBinArrayBitmapExtension,
  deriveEventAuthority,
  isInsideInlineBitmap,
} from './dlmm-pdas';
import type { DlmmPoolEntry } from './dlmm-pools';

// ─────────────────────────────────────────────────────────────────────
// Helpers — LE encoding.
// ─────────────────────────────────────────────────────────────────────

function toU64Le(v: bigint): Hex {
  if (v < 0n || v > 0xffffffffffffffffn) {
    throw new Error(`u64 out of range: ${v}`);
  }
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v, 0);
  return ('0x' + b.toString('hex')) as Hex;
}

export type DlmmSwapAddresses = {
  user: Hex;
  poolAddress: Hex;
  inputMint: Hex;
  outputMint: Hex;
  inputVault: Hex;
  outputVault: Hex;
  inputTokenProgram: Hex;
  outputTokenProgram: Hex;
  userInputAta: Hex;
  userOutputAta: Hex;
  oracle: Hex;
  bitmapExtension: Hex; // populated even when not used (program id placeholder)
  hostFeeIn: Hex; // ditto
  eventAuthority: Hex;
  /// All bin_array PDAs included as remaining_accounts, in traversal order.
  binArrays: Hex[];
};

export type DlmmSwapInvoke = {
  program: Hex;
  accounts: AccountMeta[];
  data: Hex;
  addresses: DlmmSwapAddresses;
};

/// Build a DLMM `swap` invoke.
///
/// `swapXForY` true = user spends token_x, receives token_y.
/// `swapXForY` false = user spends token_y, receives token_x.
///
/// Bin-array remaining accounts: we pass the active array first, then
/// the immediate neighbor on the swap-direction side IF that neighbor
/// is verified to exist in the registry. For the seeded pool with
/// active_id=2115 (bai=30), neighbor lower (29) exists and upper (31)
/// doesn't — so X→Y (active_id increases, traversing toward upper
/// neighbor) only includes the active array, while Y→X includes both
/// active + lower. The DLMM program walks the bitmap to find the next
/// initialized array, so passing only the current one is enough for
/// any swap that doesn't cross a boundary.
export function buildDlmmSwapInvoke(args: {
  userEvmAddress: Address;
  pool: DlmmPoolEntry;
  /// `true` = user spends token_x; `false` = user spends token_y.
  swapXForY: boolean;
  /// Exact input amount, mint smallest unit.
  amountIn: bigint;
  /// Slippage guard. Program reverts if realized output is below this.
  minimumAmountOut: bigint;
}): DlmmSwapInvoke {
  const user = deriveRomeUserPda(args.userEvmAddress);

  const inputMint = args.swapXForY ? args.pool.tokenXMint : args.pool.tokenYMint;
  const outputMint = args.swapXForY ? args.pool.tokenYMint : args.pool.tokenXMint;
  const inputVault = args.swapXForY ? args.pool.reserveX : args.pool.reserveY;
  const outputVault = args.swapXForY ? args.pool.reserveY : args.pool.reserveX;
  const inputTokenProgram = args.swapXForY
    ? args.pool.tokenXProgram
    : args.pool.tokenYProgram;
  const outputTokenProgram = args.swapXForY
    ? args.pool.tokenYProgram
    : args.pool.tokenXProgram;

  // Caller-controlled user ATAs. `deriveAta` uses classic SPL Token —
  // fine for our seeded WSOL/USDC pool (both program flags = 0). When
  // the registry adds Token-2022 pools, switch derivation to the
  // token-program-aware form.
  const userInputAta = deriveAta(user, inputMint);
  const userOutputAta = deriveAta(user, outputMint);

  // Optional accounts — DLMM uses the program id as the "absent"
  // sentinel. (Anchor's `optional` decoder treats program-id-in-slot
  // as None.)
  const bitmapExt = isInsideInlineBitmap(args.pool.seededBinArrayIndex)
    ? DLMM_PROGRAM
    : deriveBinArrayBitmapExtension(args.pool.poolBs58);
  const hostFeeIn = DLMM_PROGRAM;

  const eventAuthority = deriveEventAuthority();

  // Bin-array remaining accounts.
  // Always include the active array. Add the neighbor on the swap-
  // direction side IF it's verified to exist.
  const activeBai = args.pool.seededBinArrayIndex;
  const binArrayHexes: Hex[] = [deriveBinArray(args.pool.poolBs58, activeBai)];

  // X→Y means the swap moves price DOWN in DLMM's convention (token_y
  // is the "quote" in their docs; price = y / x). Active id can move
  // either direction depending on liquidity orientation; for the
  // seeded pool we conservatively include lower neighbor on Y→X
  // (which historically required it on the chosen pool when active_id
  // walks toward array idx 29).
  if (args.swapXForY && args.pool.neighborUpperExists) {
    binArrayHexes.push(deriveBinArray(args.pool.poolBs58, activeBai + 1));
  }
  if (!args.swapXForY && args.pool.neighborLowerExists) {
    binArrayHexes.push(deriveBinArray(args.pool.poolBs58, activeBai - 1));
  }

  const accounts: AccountMeta[] = [
    { pubkey: args.pool.poolHex, is_signer: false, is_writable: true },
    { pubkey: bitmapExt, is_signer: false, is_writable: false },
    { pubkey: inputVault, is_signer: false, is_writable: true },
    { pubkey: outputVault, is_signer: false, is_writable: true },
    { pubkey: userInputAta, is_signer: false, is_writable: true },
    { pubkey: userOutputAta, is_signer: false, is_writable: true },
    { pubkey: inputMint, is_signer: false, is_writable: false },
    { pubkey: outputMint, is_signer: false, is_writable: false },
    { pubkey: args.pool.oracle, is_signer: false, is_writable: true },
    { pubkey: hostFeeIn, is_signer: false, is_writable: true },
    { pubkey: user, is_signer: true, is_writable: false },
    { pubkey: inputTokenProgram, is_signer: false, is_writable: false },
    { pubkey: outputTokenProgram, is_signer: false, is_writable: false },
    { pubkey: eventAuthority, is_signer: false, is_writable: false },
    { pubkey: DLMM_PROGRAM, is_signer: false, is_writable: false },
    // remaining_accounts:
    ...binArrayHexes.map(
      (pubkey) =>
        ({ pubkey, is_signer: false, is_writable: true }) as AccountMeta,
    ),
  ];

  // Important: the DLMM swap account list above pins `reserve_x` and
  // `reserve_y` based on the user's swap direction (input on side 2,
  // output on side 3). But the IDL declares fixed positions — slot 2 =
  // reserve_x, slot 3 = reserve_y. Re-shuffle so the DLMM program sees
  // them in the canonical (reserve_x, reserve_y) order regardless of
  // direction; user_token_in / user_token_out continue to follow the
  // direction.
  const canonical: AccountMeta[] = [
    { pubkey: args.pool.poolHex, is_signer: false, is_writable: true },
    { pubkey: bitmapExt, is_signer: false, is_writable: false },
    { pubkey: args.pool.reserveX, is_signer: false, is_writable: true },
    { pubkey: args.pool.reserveY, is_signer: false, is_writable: true },
    { pubkey: userInputAta, is_signer: false, is_writable: true },
    { pubkey: userOutputAta, is_signer: false, is_writable: true },
    { pubkey: args.pool.tokenXMint, is_signer: false, is_writable: false },
    { pubkey: args.pool.tokenYMint, is_signer: false, is_writable: false },
    { pubkey: args.pool.oracle, is_signer: false, is_writable: true },
    { pubkey: hostFeeIn, is_signer: false, is_writable: true },
    { pubkey: user, is_signer: true, is_writable: false },
    {
      pubkey: args.pool.tokenXProgram,
      is_signer: false,
      is_writable: false,
    },
    {
      pubkey: args.pool.tokenYProgram,
      is_signer: false,
      is_writable: false,
    },
    { pubkey: eventAuthority, is_signer: false, is_writable: false },
    { pubkey: DLMM_PROGRAM, is_signer: false, is_writable: false },
    ...binArrayHexes.map(
      (pubkey) =>
        ({ pubkey, is_signer: false, is_writable: true }) as AccountMeta,
    ),
  ];

  const data = concat([
    SWAP_DISC,
    toU64Le(args.amountIn),
    toU64Le(args.minimumAmountOut),
  ]);

  return {
    program: DLMM_PROGRAM,
    accounts: canonical,
    data,
    addresses: {
      user,
      poolAddress: args.pool.poolHex,
      inputMint,
      outputMint,
      inputVault,
      outputVault,
      inputTokenProgram,
      outputTokenProgram,
      userInputAta,
      userOutputAta,
      oracle: args.pool.oracle,
      bitmapExtension: bitmapExt,
      hostFeeIn,
      eventAuthority,
      binArrays: binArrayHexes,
    },
  };
}

/// Convenience: derive the active bin_array PDA without re-reading the
/// pool registry. Used by the smoke script.
export function activeBinArrayPda(
  poolBs58: string,
  activeBinId: number,
): { binArrayIndex: number; pdaHex: Hex } {
  const idx = binArrayIndexForBinId(activeBinId);
  return { binArrayIndex: idx, pdaHex: deriveBinArray(poolBs58, idx) };
}
