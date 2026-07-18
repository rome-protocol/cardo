// SPL Stake Pool instruction builders for Cardo /stake.
//
// Pattern matches `lib/meteora-swap.ts` and `lib/kamino-instructions.ts`:
// pure functions, no network reads, no hooks. Caller passes resolved
// pool state (the stake-pool registry's curated entries).
//
// IDL is **not Anchor** — see `lib/stake-pool-program.ts` header for
// the bincode-tagged instruction shape.
//
// Account orderings cross-checked against
//   stake-pool/program/src/processor.rs::process_deposit_sol
// at github.com/solana-labs/solana-program-library
//
// We use direct-precompile from EOA (msg.sender == userEoa at the CPI
// precompile) so Rome auto-signs as the user's external-authority PDA,
// which owns the user's SPL ATAs on the Solana side (where the pool
// tokens land).
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md
// (Family 1, Phase A — Sprint 1).

import { concat, numberToHex, type Address, type Hex } from 'viem';
import { PublicKey } from '@solana/web3.js';
import type { AccountMeta } from './cpi-precompile';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  bytes32ToPublicKey,
  deriveAta,
  deriveRomeUserPda,
  pubkeyBs58ToBytes32,
  pubkeyToBytes32,
} from './solana-pda';
import {
  SPL_STAKE_POOL_PROGRAM,
  STAKE_POOL_TAG_DEPOSIT_SOL,
  STAKE_POOL_TAG_DEPOSIT_SOL_WITH_SLIPPAGE,
  STAKE_POOL_TAG_WITHDRAW_SOL,
  STAKE_POOL_TAG_WITHDRAW_SOL_WITH_SLIPPAGE,
  WITHDRAW_AUTHORITY_SEED,
} from './stake-pool-program';

// ─────────────────────────────────────────────────────────────────────
// Sysvars + program ids (bytes32 form)
// ─────────────────────────────────────────────────────────────────────

const SYSTEM_PROGRAM = pubkeyToBytes32(PublicKey.default);
const SPL_TOKEN_PROGRAM_HEX = pubkeyToBytes32(SPL_TOKEN_PROGRAM_ID);

// ─────────────────────────────────────────────────────────────────────
// Encoding helpers (mirror lib/meteora-swap.ts conventions)
// ─────────────────────────────────────────────────────────────────────

export function toU64Le(value: bigint): Hex {
  if (value < 0n || value > 0xffffffffffffffffn) {
    throw new Error(`u64 out of range: ${value}`);
  }
  const beHex = numberToHex(value, { size: 8 }).slice(2);
  const bytes: string[] = [];
  for (let i = beHex.length; i > 0; i -= 2) bytes.push(beHex.slice(i - 2, i));
  return ('0x' + bytes.join('')) as Hex;
}

// ─────────────────────────────────────────────────────────────────────
// PDA derivations
// ─────────────────────────────────────────────────────────────────────

/// Derive the stake-pool's withdraw authority PDA:
///   PDA([stake_pool, "withdraw"], SPL_STAKE_POOL_PROGRAM)
export function deriveStakePoolWithdrawAuthority(stakePool: Hex): Hex {
  const sp = bytes32ToPublicKey(stakePool);
  const program = bytes32ToPublicKey(SPL_STAKE_POOL_PROGRAM);
  const [authority] = PublicKey.findProgramAddressSync(
    [sp.toBuffer(), WITHDRAW_AUTHORITY_SEED],
    program,
  );
  return pubkeyToBytes32(authority);
}

// ─────────────────────────────────────────────────────────────────────
// Pool definition — what the registry resolves to per LST
// ─────────────────────────────────────────────────────────────────────

/// Resolved pool metadata. Most fields can be derived from
/// `stakePool` via on-chain reads, but for shipping speed the registry
/// hardcodes the constant ones (mint, manager_fee_account, reserve_stake)
/// and reads the others as needed.
export type StakePoolAccounts = {
  /// The StakePool account (writable).
  stakePool: Hex;
  /// The reserve stake account (writable). Where deposited SOL lands.
  /// Read once from on-chain StakePool; constant per pool.
  reserveStake: Hex;
  /// The pool's SPL mint (writable). Pool tokens are minted from here.
  /// Same as the LST's mint (e.g. JitoSOL mint).
  poolMint: Hex;
  /// Pool's manager fee receiver (writable). Constant per pool.
  managerFeeAccount: Hex;
  /// Optional referral receiver (writable). When unused, pass the same
  /// pubkey as `managerFeeAccount` (canonical "no referral" pattern).
  /// Some integrators pass their own referral ATA to capture rebates.
  referralFeeAccount: Hex;
};

// ─────────────────────────────────────────────────────────────────────
// DepositSol — single-ix LST deposit. No init, no refresh.
//
// IDL (stake-pool/program/src/processor.rs::process_deposit_sol):
//   1. stake_pool                       (w)
//   2. stake_pool_withdraw_authority    (r, PDA)
//   3. reserve_stake_account            (w)
//   4. lamports_from                    (signer, w) — user's Rome PDA
//   5. pool_tokens_to                   (w) — user's ATA for poolMint
//   6. manager_fee_account              (w)
//   7. referral_fee_account             (w)
//   8. pool_mint                        (w)
//   9. system_program                   (r)
//  10. token_program                    (r)
//
// Some pools enable a `sol_deposit_authority` gate; when present, the
// authority is appended as account 11 and must sign. **All major public
// LSTs (Jito, jupSOL, bSOL, dSOL, jSOL, Phantom, Edgevana) have this
// disabled.** The registry should flag pools that require it; v1 does
// not support gated pools.
//
// data = u8(14) || u64le(lamports)
// ─────────────────────────────────────────────────────────────────────

export type StakePoolDepositSolInvoke = {
  program: Hex;
  accounts: AccountMeta[];
  data: Hex;
  /// Echoed for the preview panel.
  addresses: { user: Hex; userPoolAta: Hex; withdrawAuthority: Hex };
};

export function buildDepositSolInvoke(args: {
  userEvmAddress: Address;
  pool: StakePoolAccounts;
  lamports: bigint;
}): StakePoolDepositSolInvoke {
  const user = deriveRomeUserPda(args.userEvmAddress);
  const userPoolAta = deriveAta(user, args.pool.poolMint);
  const withdrawAuthority = deriveStakePoolWithdrawAuthority(args.pool.stakePool);

  const accounts: AccountMeta[] = [
    { pubkey: args.pool.stakePool, is_signer: false, is_writable: true },
    { pubkey: withdrawAuthority, is_signer: false, is_writable: false },
    { pubkey: args.pool.reserveStake, is_signer: false, is_writable: true },
    { pubkey: user, is_signer: true, is_writable: true }, // Rome PDA, auto-signed
    { pubkey: userPoolAta, is_signer: false, is_writable: true },
    { pubkey: args.pool.managerFeeAccount, is_signer: false, is_writable: true },
    { pubkey: args.pool.referralFeeAccount, is_signer: false, is_writable: true },
    { pubkey: args.pool.poolMint, is_signer: false, is_writable: true },
    { pubkey: SYSTEM_PROGRAM, is_signer: false, is_writable: false },
    { pubkey: SPL_TOKEN_PROGRAM_HEX, is_signer: false, is_writable: false },
  ];

  // u8 tag + u64le lamports, all in one buffer
  const tag = ('0x' + STAKE_POOL_TAG_DEPOSIT_SOL.toString(16).padStart(2, '0')) as Hex;
  const data = concat([tag, toU64Le(args.lamports)]);

  return {
    program: SPL_STAKE_POOL_PROGRAM,
    accounts,
    data,
    addresses: { user, userPoolAta, withdrawAuthority },
  };
}

// ─────────────────────────────────────────────────────────────────────
// WithdrawSol — single-ix LST redemption. Burns pool tokens from the
// user's ATA, transfers SOL out of the reserve stake account back to
// the user's PDA (lamports_to).
//
// IDL (stake-pool/program/src/processor.rs::process_withdraw_sol):
//   1.  stake_pool                       (w)
//   2.  stake_pool_withdraw_authority    (r, PDA)
//   3.  user_transfer_authority          (signer) — user's Rome PDA
//   4.  user_pool_token_account          (w) — user's ATA for poolMint
//   5.  reserve_stake_account            (w)
//   6.  lamports_to                      (w) — user's Rome PDA (SOL dest)
//   7.  manager_fee_account              (w)
//   8.  pool_mint                        (w)
//   9.  clock_sysvar                     (r)
//   10. stake_history_sysvar             (r)
//   11. stake_program                    (r)
//   12. token_program                    (r)
//
// Some pools enable a `sol_withdraw_authority` gate (admin-only
// redemption). All major public LSTs disable it; v1 doesn't support
// gated pools.
//
// data = u8(16) || u64le(pool_tokens_in)
// ─────────────────────────────────────────────────────────────────────

const CLOCK_SYSVAR = pubkeyBs58ToBytes32(
  'SysvarC1ock11111111111111111111111111111111',
);
const STAKE_HISTORY_SYSVAR = pubkeyBs58ToBytes32(
  'SysvarStakeHistory1111111111111111111111111',
);
const STAKE_PROGRAM = pubkeyBs58ToBytes32(
  'Stake11111111111111111111111111111111111111',
);

export type StakePoolWithdrawSolInvoke = {
  program: Hex;
  accounts: AccountMeta[];
  data: Hex;
  addresses: { user: Hex; userPoolAta: Hex; withdrawAuthority: Hex };
};

export function buildWithdrawSolInvoke(args: {
  userEvmAddress: Address;
  pool: StakePoolAccounts;
  /// Pool tokens (LST) to burn, in mint smallest unit (matches poolMint
  /// decimals — typically 9 for SOL-class LSTs).
  poolTokensIn: bigint;
}): StakePoolWithdrawSolInvoke {
  const user = deriveRomeUserPda(args.userEvmAddress);
  const userPoolAta = deriveAta(user, args.pool.poolMint);
  const withdrawAuthority = deriveStakePoolWithdrawAuthority(args.pool.stakePool);

  const accounts: AccountMeta[] = [
    { pubkey: args.pool.stakePool, is_signer: false, is_writable: true },
    { pubkey: withdrawAuthority, is_signer: false, is_writable: false },
    { pubkey: user, is_signer: true, is_writable: false }, // user_transfer_authority
    { pubkey: userPoolAta, is_signer: false, is_writable: true },
    { pubkey: args.pool.reserveStake, is_signer: false, is_writable: true },
    { pubkey: user, is_signer: false, is_writable: true }, // lamports_to (PDA receives SOL)
    { pubkey: args.pool.managerFeeAccount, is_signer: false, is_writable: true },
    { pubkey: args.pool.poolMint, is_signer: false, is_writable: true },
    { pubkey: CLOCK_SYSVAR, is_signer: false, is_writable: false },
    { pubkey: STAKE_HISTORY_SYSVAR, is_signer: false, is_writable: false },
    { pubkey: STAKE_PROGRAM, is_signer: false, is_writable: false },
    { pubkey: SPL_TOKEN_PROGRAM_HEX, is_signer: false, is_writable: false },
  ];

  const tag = ('0x' + STAKE_POOL_TAG_WITHDRAW_SOL.toString(16).padStart(2, '0')) as Hex;
  const data = concat([tag, toU64Le(args.poolTokensIn)]);

  return {
    program: SPL_STAKE_POOL_PROGRAM,
    accounts,
    data,
    addresses: { user, userPoolAta, withdrawAuthority },
  };
}

// ─────────────────────────────────────────────────────────────────────
// DepositSolWithSlippage (tag 24) — identical account list to
// DepositSol; data = u8(24) || u64le(lamports_in) || u64le(min_pool_out).
// On-chain min-output guard so a delayed tx can't accept stale rates.
//
// ⚠ The Solana-devnet SPoo1Ku8… deployment (slot 197328814) predates
// tags 22-25: on devnet these dispatch to BorshIoError. Use the plain
// variants there; see tests/cases/stake-pool.ts canaries.
// ─────────────────────────────────────────────────────────────────────

export function buildDepositSolWithSlippageInvoke(args: {
  userEvmAddress: Address;
  pool: StakePoolAccounts;
  /// Lamports being deposited.
  lamports: bigint;
  /// Minimum pool tokens (LST) the user accepts. Tx reverts on-chain
  /// if the realized output falls below.
  minimumPoolTokensOut: bigint;
}): StakePoolDepositSolInvoke {
  const user = deriveRomeUserPda(args.userEvmAddress);
  const userPoolAta = deriveAta(user, args.pool.poolMint);
  const withdrawAuthority = deriveStakePoolWithdrawAuthority(args.pool.stakePool);

  const accounts: AccountMeta[] = [
    { pubkey: args.pool.stakePool, is_signer: false, is_writable: true },
    { pubkey: withdrawAuthority, is_signer: false, is_writable: false },
    { pubkey: args.pool.reserveStake, is_signer: false, is_writable: true },
    { pubkey: user, is_signer: true, is_writable: true },
    { pubkey: userPoolAta, is_signer: false, is_writable: true },
    { pubkey: args.pool.managerFeeAccount, is_signer: false, is_writable: true },
    { pubkey: args.pool.referralFeeAccount, is_signer: false, is_writable: true },
    { pubkey: args.pool.poolMint, is_signer: false, is_writable: true },
    { pubkey: SYSTEM_PROGRAM, is_signer: false, is_writable: false },
    { pubkey: SPL_TOKEN_PROGRAM_HEX, is_signer: false, is_writable: false },
  ];

  const tag = ('0x' +
    STAKE_POOL_TAG_DEPOSIT_SOL_WITH_SLIPPAGE.toString(16).padStart(2, '0')) as Hex;
  const data = concat([
    tag,
    toU64Le(args.lamports),
    toU64Le(args.minimumPoolTokensOut),
  ]);

  return {
    program: SPL_STAKE_POOL_PROGRAM,
    accounts,
    data,
    addresses: { user, userPoolAta, withdrawAuthority },
  };
}

// ─────────────────────────────────────────────────────────────────────
// WithdrawSolWithSlippage (tag 25) — identical account list to
// WithdrawSol; data = u8(25) || u64le(pool_tokens_in) || u64le(min_lamports_out).
// ─────────────────────────────────────────────────────────────────────

export function buildWithdrawSolWithSlippageInvoke(args: {
  userEvmAddress: Address;
  pool: StakePoolAccounts;
  poolTokensIn: bigint;
  minimumLamportsOut: bigint;
}): StakePoolWithdrawSolInvoke {
  const user = deriveRomeUserPda(args.userEvmAddress);
  const userPoolAta = deriveAta(user, args.pool.poolMint);
  const withdrawAuthority = deriveStakePoolWithdrawAuthority(args.pool.stakePool);

  const accounts: AccountMeta[] = [
    { pubkey: args.pool.stakePool, is_signer: false, is_writable: true },
    { pubkey: withdrawAuthority, is_signer: false, is_writable: false },
    { pubkey: user, is_signer: true, is_writable: false },
    { pubkey: userPoolAta, is_signer: false, is_writable: true },
    { pubkey: args.pool.reserveStake, is_signer: false, is_writable: true },
    { pubkey: user, is_signer: false, is_writable: true },
    { pubkey: args.pool.managerFeeAccount, is_signer: false, is_writable: true },
    { pubkey: args.pool.poolMint, is_signer: false, is_writable: true },
    { pubkey: CLOCK_SYSVAR, is_signer: false, is_writable: false },
    { pubkey: STAKE_HISTORY_SYSVAR, is_signer: false, is_writable: false },
    { pubkey: STAKE_PROGRAM, is_signer: false, is_writable: false },
    { pubkey: SPL_TOKEN_PROGRAM_HEX, is_signer: false, is_writable: false },
  ];

  const tag = ('0x' +
    STAKE_POOL_TAG_WITHDRAW_SOL_WITH_SLIPPAGE.toString(16).padStart(2, '0')) as Hex;
  const data = concat([
    tag,
    toU64Le(args.poolTokensIn),
    toU64Le(args.minimumLamportsOut),
  ]);

  return {
    program: SPL_STAKE_POOL_PROGRAM,
    accounts,
    data,
    addresses: { user, userPoolAta, withdrawAuthority },
  };
}

void ASSOCIATED_TOKEN_PROGRAM_ID; // referenced in future ATA-init flows
