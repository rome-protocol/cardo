// Generic ATA-init builder for the Rome CPI precompile.
//
// Most Cardo flows use `wrapper.ensure_token_account` (the ERC20-SPL
// wrapper's bound-ATA helper). That only works for SPL mints we have a
// wrapper for. Kamino's collateral mints (cTokens) have no wrapper —
// for those, we call the Solana ATA program directly via Rome CPI:
//   create_associated_token_account_idempotent
//
// Idempotent: succeeds whether or not the ATA already exists. Safer
// than the non-idempotent variant for retried flows.
//
// Pre-flight: useAtaExists below polls the ATA pubkey and reports.

import { concat, type Address, type Hex } from 'viem';
import { PublicKey } from '@solana/web3.js';
import type { AccountMeta } from './cpi-precompile';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  bytes32ToPublicKey,
  deriveAta,
  deriveRomeUserPda,
  pubkeyToBytes32,
} from './solana-pda';

/// ATA program: createAssociatedTokenAccountIdempotent instruction
/// data is a single byte: 1 (the variant index in the ATA program's
/// instruction enum). See spl-associated-token-account source.
const ATA_IDEMPOTENT_DISC: Hex = '0x01';

const SYSTEM_PROGRAM = pubkeyToBytes32(PublicKey.default);
const ASSOC_TOKEN_PROGRAM_HEX = pubkeyToBytes32(ASSOCIATED_TOKEN_PROGRAM_ID);
const SPL_TOKEN_PROGRAM_HEX = pubkeyToBytes32(SPL_TOKEN_PROGRAM_ID);

export type AtaInitInvoke = {
  program: Hex;
  accounts: AccountMeta[];
  data: Hex;
  /// The ATA address that will exist after the tx confirms.
  ataAddress: Hex;
};

/**
 * Build an idempotent ATA-creation invoke targeting the Solana
 * Associated Token Account program. Owner is the user's Rome PDA
 * (derived from the EVM address); funding payer is the same PDA
 * (Rome auto-signs for it on the precompile path).
 *
 * Account order from
 *   solana-program-library/associated-token-account/program/src/processor.rs
 * (Idempotent variant):
 *   [0] funding_address (signer, writable)
 *   [1] associated_token_account (writable)
 *   [2] wallet (the owner)
 *   [3] mint
 *   [4] system_program
 *   [5] spl_token_program
 */
export function buildAtaInitInvoke(args: {
  userEvmAddress: Address;
  /// 0x-prefixed bytes32 of the SPL mint to create the ATA for.
  mintHex: Hex;
}): AtaInitInvoke {
  const userPda = deriveRomeUserPda(args.userEvmAddress);
  const ata = deriveAta(userPda, args.mintHex);

  const accounts: AccountMeta[] = [
    // funding_address — Rome PDA; Rome auto-signs.
    { pubkey: userPda, is_signer: true, is_writable: true },
    { pubkey: ata, is_signer: false, is_writable: true },
    { pubkey: userPda, is_signer: false, is_writable: false }, // wallet (owner)
    { pubkey: args.mintHex, is_signer: false, is_writable: false },
    { pubkey: SYSTEM_PROGRAM, is_signer: false, is_writable: false },
    { pubkey: SPL_TOKEN_PROGRAM_HEX, is_signer: false, is_writable: false },
  ];

  return {
    program: ASSOC_TOKEN_PROGRAM_HEX,
    accounts,
    data: ATA_IDEMPOTENT_DISC,
    ataAddress: ata,
  };
}

/// Read-only helper: check if an ATA exists on Solana. Hits the
/// /api/rpc/solana-devnet proxy so it works in browser context.
export async function ataExists(ataBytes32: Hex): Promise<boolean> {
  try {
    const ataBs58 = bytes32ToPublicKey(ataBytes32).toBase58();
    const res = await fetch('/api/rpc/solana-devnet', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getAccountInfo',
        params: [ataBs58, { encoding: 'base64' }],
      }),
    });
    const json = await res.json();
    return !!json.result?.value;
  } catch {
    return false;
  }
}
