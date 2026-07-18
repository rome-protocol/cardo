// Raydium CPMM PDA derivations.
//
// Source: github.com/raydium-io/raydium-cp-swap + on-chain verification
// on Solana devnet 2026-04-25 (auth_bump field on pool 2HyNe5a32u…
// matches our derivation).

import { PublicKey } from '@solana/web3.js';
import type { Hex } from 'viem';
import { bytes32ToPublicKey, pubkeyToBytes32 } from './solana-pda';
import { AUTHORITY_SEED, RAYDIUM_CPMM_PROGRAM } from './raydium-cpmm-program';

// ─────────────────────────────────────────────────────────────────────
// authority — PDA(["vault_and_lp_mint_auth_seed"], RAYDIUM_CPMM_PROGRAM)
//
// Single global PDA across the whole program. Owns the LP mint and signs
// vault-out transfers. We derive once at module load — there's no need
// to recompute per swap.
// ─────────────────────────────────────────────────────────────────────

function deriveAuthority(): Hex {
  const program = bytes32ToPublicKey(RAYDIUM_CPMM_PROGRAM);
  const [pda] = PublicKey.findProgramAddressSync([AUTHORITY_SEED], program);
  return pubkeyToBytes32(pda);
}

export const RAYDIUM_CPMM_AUTHORITY: Hex = deriveAuthority();
