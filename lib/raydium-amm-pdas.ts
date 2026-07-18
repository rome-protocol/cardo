// Raydium AMM v4 PDA derivations.
//
// Source: github.com/raydium-io/raydium-amm + on-chain verification on
// Solana devnet 2026-04-26.
//
// Two PDAs matter for swap_base_in:
//
//   1. `amm_authority` — PDA(["amm authority"], program). Single global
//      PDA across the whole program. Bump=252 on the devnet redeploy
//      (matches AmmInfo.nonce field on every pool we sampled). Owns
//      the LP mint and signs vault-out transfers.
//
//   2. `serum_vault_signer` — PDA([market, vault_signer_nonce], serum).
//      Per-market. The vault_signer_nonce is u64 LE, NOT a string seed,
//      and createProgramAddressSync must be used (not
//      findProgramAddressSync) — the nonce is fixed by the market, not
//      bump-searched. Verified against pool 8Mwd2xFB's serum_market
//      G9Yngf4PR…  (vault_signer_nonce=1 → 8FRYAtBfLL7G…).

import { PublicKey } from '@solana/web3.js';
import type { Hex } from 'viem';
import { bytes32ToPublicKey, pubkeyToBytes32 } from './solana-pda';
import {
  AMM_AUTHORITY_SEED,
  RAYDIUM_AMM_V4_PROGRAM,
} from './raydium-amm-program';

// ─────────────────────────────────────────────────────────────────────
// amm_authority — PDA(["amm authority"], RAYDIUM_AMM_V4_PROGRAM)
// ─────────────────────────────────────────────────────────────────────

function deriveAuthority(): { pda: Hex; bump: number } {
  const program = bytes32ToPublicKey(RAYDIUM_AMM_V4_PROGRAM);
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [AMM_AUTHORITY_SEED],
    program,
  );
  return { pda: pubkeyToBytes32(pda), bump };
}

const _authority = deriveAuthority();

/// Single global authority PDA. Verified bump=252 against the devnet
/// redeploy at HWy1jot… on 2026-04-26.
export const RAYDIUM_AMM_V4_AUTHORITY: Hex = _authority.pda;
export const RAYDIUM_AMM_V4_AUTHORITY_BUMP: number = _authority.bump;

// ─────────────────────────────────────────────────────────────────────
// serum_vault_signer — PDA([market, nonce_u64_le], serum_program)
//
// Per-market. The nonce comes from the serum MarketState
// (vault_signer_nonce field). Use createProgramAddressSync — the seed
// set is exactly what's stored on-chain; no bump search.
// ─────────────────────────────────────────────────────────────────────

export function deriveSerumVaultSigner(args: {
  marketHex: Hex;
  serumProgramHex: Hex;
  vaultSignerNonce: bigint;
}): Hex {
  const market = bytes32ToPublicKey(args.marketHex);
  const program = bytes32ToPublicKey(args.serumProgramHex);
  const nonceLe = Buffer.alloc(8);
  nonceLe.writeBigUInt64LE(args.vaultSignerNonce, 0);
  const ad = PublicKey.createProgramAddressSync(
    [market.toBuffer(), nonceLe],
    program,
  );
  return pubkeyToBytes32(ad);
}
