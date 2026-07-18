// Raydium AMM v4 swap_base_in invoke builder.
//
// AMM v4 ≠ CPMM. The ix is hand-rolled (no Anchor disc, single-byte u8
// tag) and takes 18 accounts. Wrong order = silent revert.
//
// Account list verified against a real successful devnet invocation
// (sig 512rcyahXgnLW4qfzgjkR3q1PK7Kff2tUTAaoqp8T47o…), cross-checked
// with raydium-amm/program/src/instruction.rs `swap_base_in` arm:
//
//    0. token_program                 (readonly)        ← Tokenkeg
//    1. amm                           (writable)        ← pool
//    2. amm_authority                 (readonly)        ← global PDA
//    3. amm_open_orders               (writable)
//    4. amm_target_orders             (writable)
//    5. pool_coin_token_account       (writable)        ← pool coin vault
//    6. pool_pc_token_account         (writable)        ← pool pc vault
//    7. serum_program                 (readonly)
//    8. serum_market                  (writable)
//    9. serum_bids                    (writable)
//   10. serum_asks                    (writable)
//   11. serum_event_queue             (writable)
//   12. serum_coin_vault_account      (writable)
//   13. serum_pc_vault_account        (writable)
//   14. serum_vault_signer            (readonly)
//   15. user_source_token_account     (writable)        ← user's input ATA
//   16. user_destination_token_account(writable)        ← user's output ATA
//   17. user_source_owner             (signer)          ← Rome user PDA
//
// Args (after the u8 tag):
//   amount_in:           u64 LE
//   minimum_amount_out:  u64 LE   ← slippage guard
//
// Source: github.com/raydium-io/raydium-amm/blob/master/program/src/instruction.rs

import { concat, type Address, type Hex } from 'viem';
import type { AccountMeta } from './cpi-precompile';
import { deriveRomeUserPda, deriveAta } from './solana-pda';
import {
  RAYDIUM_AMM_V4_PROGRAM,
  SWAP_BASE_IN_TAG,
} from './raydium-amm-program';
import type { RaydiumAmmV4PoolEntry } from './raydium-amm-pools';

function toU8(v: number): Hex {
  if (v < 0 || v > 255 || !Number.isInteger(v)) {
    throw new Error(`u8 out of range: ${v}`);
  }
  return ('0x' + v.toString(16).padStart(2, '0')) as Hex;
}

function toU64Le(v: bigint): Hex {
  if (v < 0n || v > 0xffffffffffffffffn) {
    throw new Error(`u64 out of range: ${v}`);
  }
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v, 0);
  return ('0x' + b.toString('hex')) as Hex;
}

export type RaydiumAmmV4SwapAddresses = {
  user: Hex;
  poolAddress: Hex;
  authority: Hex;
  openOrders: Hex;
  targetOrders: Hex;
  poolCoinVault: Hex;
  poolPcVault: Hex;
  serumProgram: Hex;
  serumMarket: Hex;
  serumBids: Hex;
  serumAsks: Hex;
  serumEventQueue: Hex;
  serumCoinVault: Hex;
  serumPcVault: Hex;
  serumVaultSigner: Hex;
  userSourceAta: Hex;
  userDestinationAta: Hex;
  inputMint: Hex;
  outputMint: Hex;
};

export type RaydiumAmmV4SwapInvoke = {
  program: Hex;
  accounts: AccountMeta[];
  data: Hex;
  addresses: RaydiumAmmV4SwapAddresses;
};

/// Build a `swap_base_in` invoke against a Raydium AMM v4 pool.
///
/// `inputIsCoin = true` means the user spends the pool's "coin" (token_0)
/// side. `false` means they spend the pc (token_1) side. The pool itself
/// is symmetric — swap_base_in reads the input/output mints from the
/// user_source_token_account / user_destination_token_account accounts,
/// not from a discriminator — so we just shuffle the user's two ATAs.
///
/// The pool-side accounts (coin_vault / pc_vault, open_orders,
/// target_orders, serum_*) stay in their on-chain orientation regardless
/// of swap direction. Raydium's program checks the user's ATAs match
/// the on-chain mints by reading them from accounts 15/16 directly.
export function buildRaydiumAmmV4SwapBaseInInvoke(args: {
  userEvmAddress: Address;
  pool: RaydiumAmmV4PoolEntry;
  /// `true` = user spends the coin side (USDC in our seeded pool).
  /// `false` = user spends the pc side (WSOL in our seeded pool).
  inputIsCoin: boolean;
  /// Exact input amount, mint smallest unit.
  amountIn: bigint;
  /// Slippage guard. Caller computes from `quoteRaydiumAmmV4SwapBaseIn`
  /// minus a tolerance. The program reverts if the realized output is
  /// below.
  minimumAmountOut: bigint;
}): RaydiumAmmV4SwapInvoke {
  const user = deriveRomeUserPda(args.userEvmAddress);
  const inputMint = args.inputIsCoin
    ? args.pool.coinMint
    : args.pool.pcMint;
  const outputMint = args.inputIsCoin
    ? args.pool.pcMint
    : args.pool.coinMint;

  // ATAs for the user's PDA. AMM v4 is classic-SPL-only (predates
  // Token-2022 — every active devnet pool we sampled uses Tokenkeg).
  const userSourceAta = deriveAta(user, inputMint);
  const userDestinationAta = deriveAta(user, outputMint);

  const accounts: AccountMeta[] = [
    {
      pubkey: args.pool.tokenProgram,
      is_signer: false,
      is_writable: false,
    },
    { pubkey: args.pool.poolHex, is_signer: false, is_writable: true },
    {
      pubkey: args.pool.authority,
      is_signer: false,
      is_writable: false,
    },
    {
      pubkey: args.pool.openOrders,
      is_signer: false,
      is_writable: true,
    },
    {
      pubkey: args.pool.targetOrders,
      is_signer: false,
      is_writable: true,
    },
    { pubkey: args.pool.coinVault, is_signer: false, is_writable: true },
    { pubkey: args.pool.pcVault, is_signer: false, is_writable: true },
    {
      pubkey: args.pool.serum.program,
      is_signer: false,
      is_writable: false,
    },
    {
      pubkey: args.pool.serum.market,
      is_signer: false,
      is_writable: true,
    },
    { pubkey: args.pool.serum.bids, is_signer: false, is_writable: true },
    { pubkey: args.pool.serum.asks, is_signer: false, is_writable: true },
    {
      pubkey: args.pool.serum.eventQueue,
      is_signer: false,
      is_writable: true,
    },
    {
      pubkey: args.pool.serum.coinVault,
      is_signer: false,
      is_writable: true,
    },
    {
      pubkey: args.pool.serum.pcVault,
      is_signer: false,
      is_writable: true,
    },
    {
      pubkey: args.pool.serum.vaultSigner,
      is_signer: false,
      is_writable: false,
    },
    { pubkey: userSourceAta, is_signer: false, is_writable: true },
    { pubkey: userDestinationAta, is_signer: false, is_writable: true },
    { pubkey: user, is_signer: true, is_writable: true },
  ];

  const data = concat([
    toU8(SWAP_BASE_IN_TAG),
    toU64Le(args.amountIn),
    toU64Le(args.minimumAmountOut),
  ]);

  return {
    program: RAYDIUM_AMM_V4_PROGRAM,
    accounts,
    data,
    addresses: {
      user,
      poolAddress: args.pool.poolHex,
      authority: args.pool.authority,
      openOrders: args.pool.openOrders,
      targetOrders: args.pool.targetOrders,
      poolCoinVault: args.pool.coinVault,
      poolPcVault: args.pool.pcVault,
      serumProgram: args.pool.serum.program,
      serumMarket: args.pool.serum.market,
      serumBids: args.pool.serum.bids,
      serumAsks: args.pool.serum.asks,
      serumEventQueue: args.pool.serum.eventQueue,
      serumCoinVault: args.pool.serum.coinVault,
      serumPcVault: args.pool.serum.pcVault,
      serumVaultSigner: args.pool.serum.vaultSigner,
      userSourceAta,
      userDestinationAta,
      inputMint,
      outputMint,
    },
  };
}
