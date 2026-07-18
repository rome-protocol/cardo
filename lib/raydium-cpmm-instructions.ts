// Raydium CPMM swap_base_input invoke builder.
//
// Per the IDL, the ix takes 13 accounts in this order:
//
//   0.  payer                  (signer, writable)   ← user PDA
//   1.  authority              (readonly)           ← global PDA
//   2.  amm_config             (readonly)           ← per-pool config
//   3.  pool_state             (writable)
//   4.  input_token_account    (writable)           ← user's ATA for input mint
//   5.  output_token_account   (writable)           ← user's ATA for output mint
//   6.  input_vault            (writable)           ← pool vault for input mint
//   7.  output_vault           (writable)           ← pool vault for output mint
//   8.  input_token_program    (readonly)           ← classic SPL or Token-2022
//   9.  output_token_program   (readonly)
//   10. input_token_mint       (readonly)
//   11. output_token_mint      (readonly)
//   12. observation_state      (writable)
//
// Args (after the 8-byte disc):
//   amount_in:           u64  LE
//   minimum_amount_out:  u64  LE   ← slippage guard
//
// Source: github.com/raydium-io/raydium-cp-swap, programs/cp-swap/src/instructions/swap_base_input.rs

import { concat, type Address, type Hex } from 'viem';
import type { AccountMeta } from './cpi-precompile';
import { deriveRomeUserPda, deriveAta } from './solana-pda';
import {
  RAYDIUM_CPMM_PROGRAM,
  SWAP_BASE_INPUT_DISC,
  SWAP_BASE_OUTPUT_DISC,
} from './raydium-cpmm-program';
import { RAYDIUM_CPMM_AUTHORITY } from './raydium-cpmm-pdas';
import type { RaydiumCpmmPoolEntry } from './raydium-cpmm-pools';

function toU64Le(v: bigint): Hex {
  if (v < 0n || v > 0xffffffffffffffffn) {
    throw new Error(`u64 out of range: ${v}`);
  }
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v, 0);
  return ('0x' + b.toString('hex')) as Hex;
}

export type RaydiumCpmmSwapAddresses = {
  user: Hex;
  poolAddress: Hex;
  ammConfig: Hex;
  authority: Hex;
  inputMint: Hex;
  outputMint: Hex;
  inputVault: Hex;
  outputVault: Hex;
  inputTokenProgram: Hex;
  outputTokenProgram: Hex;
  userInputAta: Hex;
  userOutputAta: Hex;
  observationKey: Hex;
};

export type RaydiumCpmmSwapInvoke = {
  program: Hex;
  accounts: AccountMeta[];
  data: Hex;
  addresses: RaydiumCpmmSwapAddresses;
};

/// Build a `swap_base_input` invoke against a Raydium CPMM pool.
///
/// `inputIsToken0` selects which side the user is spending. The pool
/// itself is symmetric — `swap_base_input` reads the input/output mints
/// from accounts, not from a discriminator — so we just shuffle accounts.
export function buildRaydiumCpmmSwapBaseInputInvoke(args: {
  userEvmAddress: Address;
  pool: RaydiumCpmmPoolEntry;
  /// `true` = user spends token_0 (e.g. WSOL on the seeded pool).
  /// `false` = user spends token_1 (e.g. USDC on the seeded pool).
  inputIsToken0: boolean;
  /// Exact input amount, mint smallest unit.
  amountIn: bigint;
  /// Slippage guard. Caller computes from `quoteRaydiumCpmmSwapBaseInput`
  /// minus a tolerance. The program reverts if the realized output is below.
  minimumAmountOut: bigint;
}): RaydiumCpmmSwapInvoke {
  const user = deriveRomeUserPda(args.userEvmAddress);
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

  // ATAs for the user's PDA. `deriveAta` hardcodes the classic SPL
  // Token program — fine for our seeded WSOL/USDC pool. When Token-2022
  // pools join the registry, this needs an ATA-with-token-program path.
  const userInputAta = deriveAta(user, inputMint);
  const userOutputAta = deriveAta(user, outputMint);

  const accounts: AccountMeta[] = [
    { pubkey: user, is_signer: true, is_writable: true },
    { pubkey: RAYDIUM_CPMM_AUTHORITY, is_signer: false, is_writable: false },
    { pubkey: args.pool.ammConfig, is_signer: false, is_writable: false },
    { pubkey: args.pool.poolHex, is_signer: false, is_writable: true },
    { pubkey: userInputAta, is_signer: false, is_writable: true },
    { pubkey: userOutputAta, is_signer: false, is_writable: true },
    { pubkey: inputVault, is_signer: false, is_writable: true },
    { pubkey: outputVault, is_signer: false, is_writable: true },
    { pubkey: inputTokenProgram, is_signer: false, is_writable: false },
    { pubkey: outputTokenProgram, is_signer: false, is_writable: false },
    { pubkey: inputMint, is_signer: false, is_writable: false },
    { pubkey: outputMint, is_signer: false, is_writable: false },
    { pubkey: args.pool.observationKey, is_signer: false, is_writable: true },
  ];

  const data = concat([
    SWAP_BASE_INPUT_DISC,
    toU64Le(args.amountIn),
    toU64Le(args.minimumAmountOut),
  ]);

  return {
    program: RAYDIUM_CPMM_PROGRAM,
    accounts,
    data,
    addresses: {
      user,
      poolAddress: args.pool.poolHex,
      ammConfig: args.pool.ammConfig,
      authority: RAYDIUM_CPMM_AUTHORITY,
      inputMint,
      outputMint,
      inputVault,
      outputVault,
      inputTokenProgram,
      outputTokenProgram,
      userInputAta,
      userOutputAta,
      observationKey: args.pool.observationKey,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// swap_base_output — exact-output variant. Same 13-account list as
// swap_base_input (Raydium reuses the `Swap` accounts struct per
// programs/cp-swap/src/instructions/swap_base_output.rs which imports
// `Swap` from swap_base_input). Args differ:
//
//   max_amount_in: u64 LE     — slippage upper bound
//   amount_out:    u64 LE     — exact output amount user wants
// ─────────────────────────────────────────────────────────────────────

export function buildRaydiumCpmmSwapBaseOutputInvoke(args: {
  userEvmAddress: Address;
  pool: RaydiumCpmmPoolEntry;
  inputIsToken0: boolean;
  /// Slippage upper bound on input.
  maxAmountIn: bigint;
  /// Exact output amount the user wants.
  amountOut: bigint;
}): RaydiumCpmmSwapInvoke {
  const user = deriveRomeUserPda(args.userEvmAddress);
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

  const userInputAta = deriveAta(user, inputMint);
  const userOutputAta = deriveAta(user, outputMint);

  const accounts: AccountMeta[] = [
    { pubkey: user, is_signer: true, is_writable: true },
    { pubkey: RAYDIUM_CPMM_AUTHORITY, is_signer: false, is_writable: false },
    { pubkey: args.pool.ammConfig, is_signer: false, is_writable: false },
    { pubkey: args.pool.poolHex, is_signer: false, is_writable: true },
    { pubkey: userInputAta, is_signer: false, is_writable: true },
    { pubkey: userOutputAta, is_signer: false, is_writable: true },
    { pubkey: inputVault, is_signer: false, is_writable: true },
    { pubkey: outputVault, is_signer: false, is_writable: true },
    { pubkey: inputTokenProgram, is_signer: false, is_writable: false },
    { pubkey: outputTokenProgram, is_signer: false, is_writable: false },
    { pubkey: inputMint, is_signer: false, is_writable: false },
    { pubkey: outputMint, is_signer: false, is_writable: false },
    { pubkey: args.pool.observationKey, is_signer: false, is_writable: true },
  ];

  const data = concat([
    SWAP_BASE_OUTPUT_DISC,
    toU64Le(args.maxAmountIn),
    toU64Le(args.amountOut),
  ]);

  return {
    program: RAYDIUM_CPMM_PROGRAM,
    accounts,
    data,
    addresses: {
      user,
      poolAddress: args.pool.poolHex,
      ammConfig: args.pool.ammConfig,
      authority: RAYDIUM_CPMM_AUTHORITY,
      inputMint,
      outputMint,
      inputVault,
      outputVault,
      inputTokenProgram,
      outputTokenProgram,
      userInputAta,
      userOutputAta,
      observationKey: args.pool.observationKey,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// deposit (LP add) — verified vs cp-swap/instructions/deposit.rs (13 accts):
//
//   1.  owner (signer)
//   2.  authority (ro)               ← global PDA
//   3.  pool_state (mut)
//   4.  owner_lp_token (mut)         ← user's ATA for lpMint
//   5.  token_0_account (mut)
//   6.  token_1_account (mut)
//   7.  token_0_vault (mut)
//   8.  token_1_vault (mut)
//   9.  token_program (ro)
//   10. token_program_2022 (ro)
//   11. vault_0_mint (ro)
//   12. vault_1_mint (ro)
//   13. lp_mint (mut)
//
// Args: lp_token_amount u64 || maximum_token_0_amount u64 || maximum_token_1_amount u64
//
// Anchor disc shared with all `deposit` ix → 0xf223c68952e1f2b6.
// ─────────────────────────────────────────────────────────────────────

// Hardcoded SPL Token-2022 program (verified pubkey
// TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb). Required by the
// deposit/withdraw account list even when the pool's vaults are
// classic SPL Token — Raydium passes both program slots.
import { pubkeyBs58ToBytes32 as _pkb58 } from './solana-pda';
const T22_PROGRAM: Hex = _pkb58('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const MEMO_PROGRAM_HEX_CPMM: Hex = _pkb58(
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
);

export type RaydiumCpmmLpAddresses = {
  user: Hex;
  userLpAta: Hex;
  userToken0Ata: Hex;
  userToken1Ata: Hex;
};

export type RaydiumCpmmLpInvoke = {
  program: Hex;
  accounts: AccountMeta[];
  data: Hex;
  addresses: RaydiumCpmmLpAddresses;
};

const RAYDIUM_CPMM_DEPOSIT_DISC: Hex = '0xf223c68952e1f2b6';
const RAYDIUM_CPMM_WITHDRAW_DISC: Hex = '0xb712469c946da122';

function lpAccountList(args: {
  user: Hex;
  pool: RaydiumCpmmPoolEntry;
  userLpAta: Hex;
  userToken0Ata: Hex;
  userToken1Ata: Hex;
}): AccountMeta[] {
  return [
    { pubkey: args.user, is_signer: true, is_writable: false },
    { pubkey: RAYDIUM_CPMM_AUTHORITY, is_signer: false, is_writable: false },
    { pubkey: args.pool.poolHex, is_signer: false, is_writable: true },
    { pubkey: args.userLpAta, is_signer: false, is_writable: true },
    { pubkey: args.userToken0Ata, is_signer: false, is_writable: true },
    { pubkey: args.userToken1Ata, is_signer: false, is_writable: true },
    { pubkey: args.pool.token0Vault, is_signer: false, is_writable: true },
    { pubkey: args.pool.token1Vault, is_signer: false, is_writable: true },
    { pubkey: args.pool.token0Program, is_signer: false, is_writable: false },
    { pubkey: T22_PROGRAM, is_signer: false, is_writable: false },
    { pubkey: args.pool.token0Mint, is_signer: false, is_writable: false },
    { pubkey: args.pool.token1Mint, is_signer: false, is_writable: false },
    { pubkey: args.pool.lpMint, is_signer: false, is_writable: true },
  ];
}

export function buildRaydiumCpmmDepositInvoke(args: {
  userEvmAddress: Address;
  pool: RaydiumCpmmPoolEntry;
  /// LP tokens to mint to user.
  lpTokenAmount: bigint;
  /// Max token_0 + token_1 user is willing to spend.
  maximumToken0Amount: bigint;
  maximumToken1Amount: bigint;
}): RaydiumCpmmLpInvoke {
  const user = deriveRomeUserPda(args.userEvmAddress);
  const userLpAta = deriveAta(user, args.pool.lpMint);
  const userToken0Ata = deriveAta(user, args.pool.token0Mint);
  const userToken1Ata = deriveAta(user, args.pool.token1Mint);

  const accounts = lpAccountList({
    user,
    pool: args.pool,
    userLpAta,
    userToken0Ata,
    userToken1Ata,
  });

  const data = concat([
    RAYDIUM_CPMM_DEPOSIT_DISC,
    toU64Le(args.lpTokenAmount),
    toU64Le(args.maximumToken0Amount),
    toU64Le(args.maximumToken1Amount),
  ]);

  return {
    program: RAYDIUM_CPMM_PROGRAM,
    accounts,
    data,
    addresses: { user, userLpAta, userToken0Ata, userToken1Ata },
  };
}

// withdraw adds a 14th account: memo_program at the end.
export function buildRaydiumCpmmWithdrawInvoke(args: {
  userEvmAddress: Address;
  pool: RaydiumCpmmPoolEntry;
  /// LP tokens to burn.
  lpTokenAmount: bigint;
  /// Slippage lower bounds on token_0 + token_1 the user accepts.
  minimumToken0Amount: bigint;
  minimumToken1Amount: bigint;
}): RaydiumCpmmLpInvoke {
  const user = deriveRomeUserPda(args.userEvmAddress);
  const userLpAta = deriveAta(user, args.pool.lpMint);
  const userToken0Ata = deriveAta(user, args.pool.token0Mint);
  const userToken1Ata = deriveAta(user, args.pool.token1Mint);

  const baseAccounts = lpAccountList({
    user,
    pool: args.pool,
    userLpAta,
    userToken0Ata,
    userToken1Ata,
  });
  const accounts: AccountMeta[] = [
    ...baseAccounts,
    { pubkey: MEMO_PROGRAM_HEX_CPMM, is_signer: false, is_writable: false },
  ];

  const data = concat([
    RAYDIUM_CPMM_WITHDRAW_DISC,
    toU64Le(args.lpTokenAmount),
    toU64Le(args.minimumToken0Amount),
    toU64Le(args.minimumToken1Amount),
  ]);

  return {
    program: RAYDIUM_CPMM_PROGRAM,
    accounts,
    data,
    addresses: { user, userLpAta, userToken0Ata, userToken1Ata },
  };
}

