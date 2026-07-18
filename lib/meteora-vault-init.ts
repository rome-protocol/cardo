// Meteora dynamic-vault initialize, encoded for Rome CPI precompile.
//
// One-tx setup that turns an SPL mint into a Meteora-vault-backed
// asset. Required precondition before Cardo /pool/new can create a
// Meteora pool for that mint. Cheap (~0.011 SOL of rent across vault,
// token_vault, lp_mint), idempotent at the contract level (vault PDA
// is deterministic on `["vault", mint, BASE]`).
//
// Submission goes through the same direct-precompile path as the
// swap and pool-init flows — `msg.sender at 0xFF…08 == userEoa` so
// Rome auto-signs for the user's external-authority PDA, which acts
// as the `payer` in the vault's Anchor `init` constraints.
//
// Source of truth for layout:
//   rome-sdk/rome-meteora/src/dammv1/dynamic-vault/src/lib.rs
//   (`Initialize<'info>` struct).

import { type Address, type Hex } from 'viem';
import { PublicKey } from '@solana/web3.js';
import type { AccountMeta } from './cpi-precompile';
import {
  bytes32ToPublicKey,
  deriveRomeUserPda,
  pubkeyBs58ToBytes32,
  pubkeyToBytes32,
  SPL_TOKEN_PROGRAM_ID,
} from './solana-pda';
import {
  METEORA_VAULT_PROGRAM_ID,
  deriveMeteoraVault,
  deriveVaultLpMint,
  deriveVaultTokenAccount,
} from './meteora-pool-create';

/// Anchor instruction discriminator: sha256("global:initialize")[0..8].
/// Confirmed against the live tx that bootstrapped WETH's vault on
/// 2026-04-24 (Xxuod4ojy…LcK81).
export const METEORA_INIT_VAULT_DISC: Hex = '0xafaf6d1f0d989bed';

/// Meteora vault program in bytes32 form.
const METEORA_VAULT_PROGRAM_HEX = pubkeyToBytes32(METEORA_VAULT_PROGRAM_ID);

/// SPL Token program in bytes32 form.
const SPL_TOKEN_PROGRAM_HEX = pubkeyToBytes32(SPL_TOKEN_PROGRAM_ID);

/// Sysvar rent.
const SYSVAR_RENT_HEX = pubkeyBs58ToBytes32(
  'SysvarRent111111111111111111111111111111111',
);

/// System program (32 zero bytes).
const SYSTEM_PROGRAM_HEX = pubkeyToBytes32(PublicKey.default);

export type VaultInitInvoke = {
  program: Hex;
  accounts: AccountMeta[];
  data: Hex;
  /// Derived addresses, exposed so callers can show them in a preview
  /// panel before the user signs.
  addresses: {
    vault: PublicKey;
    tokenVault: PublicKey;
    lpMint: PublicKey;
  };
};

/**
 * Resolve every PDA + account meta needed for Meteora's
 * `dynamic_vault.initialize` instruction, then return the calldata
 * triple ready to drop into wagmi.writeContract.
 */
export function buildChainMeteoraVaultInitInvoke(args: {
  userEvmAddress: Address;
  /// 0x-prefixed bytes32 of the SPL mint we're spinning a vault for.
  mintHex: Hex;
}): VaultInitInvoke {
  const mint = bytes32ToPublicKey(args.mintHex);
  const vault = deriveMeteoraVault(mint);
  const tokenVault = deriveVaultTokenAccount(vault);
  const lpMint = deriveVaultLpMint(vault);
  const userPda = deriveRomeUserPda(args.userEvmAddress);

  // Order from the Initialize struct in dynamic-vault/src/lib.rs:
  //   0 vault          init, w
  //   1 payer          signer, w
  //   2 token_vault    init, w
  //   3 token_mint     r
  //   4 lp_mint        init, w
  //   5 rent           sysvar
  //   6 token_program  r
  //   7 system_program r
  const accounts: AccountMeta[] = [
    { pubkey: pubkeyToBytes32(vault), is_signer: false, is_writable: true },
    { pubkey: userPda, is_signer: true, is_writable: true },
    { pubkey: pubkeyToBytes32(tokenVault), is_signer: false, is_writable: true },
    { pubkey: args.mintHex, is_signer: false, is_writable: false },
    { pubkey: pubkeyToBytes32(lpMint), is_signer: false, is_writable: true },
    { pubkey: SYSVAR_RENT_HEX, is_signer: false, is_writable: false },
    { pubkey: SPL_TOKEN_PROGRAM_HEX, is_signer: false, is_writable: false },
    { pubkey: SYSTEM_PROGRAM_HEX, is_signer: false, is_writable: false },
  ];

  return {
    program: METEORA_VAULT_PROGRAM_HEX,
    accounts,
    data: METEORA_INIT_VAULT_DISC,
    addresses: { vault, tokenVault, lpMint },
  };
}
