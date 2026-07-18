// Phoenix PDA derivations.
//
// Source: github.com/Ellipsis-Labs/phoenix-v1, src/lib.rs +
// src/program/validation/loaders.rs.

import { PublicKey } from '@solana/web3.js';
import type { Hex } from 'viem';
import { pubkeyToBytes32, pubkeyBs58ToBytes32 } from './solana-pda';
import { PHOENIX_PROGRAM_BS58, PHOENIX_LOG_AUTHORITY_BS58 } from './phoenix-program';

const PHOENIX_PROGRAM_PK = new PublicKey(PHOENIX_PROGRAM_BS58);

// ─────────────────────────────────────────────────────────────────────
// log_authority — PDA(["log"], PHOENIX_PROGRAM)
//
// Derive once at module load and assert against the static address
// hard-coded in Phoenix source. If we ever upgrade Phoenix to a new
// program id, this assertion catches the drift.
// ─────────────────────────────────────────────────────────────────────

function deriveLogAuthority(): Hex {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('log')],
    PHOENIX_PROGRAM_PK,
  );
  if (pda.toBase58() !== PHOENIX_LOG_AUTHORITY_BS58) {
    throw new Error(
      `phoenix log authority drift: derived ${pda.toBase58()}, expected ${PHOENIX_LOG_AUTHORITY_BS58}`,
    );
  }
  return pubkeyToBytes32(pda);
}

export const PHOENIX_LOG_AUTHORITY: Hex = deriveLogAuthority();

// ─────────────────────────────────────────────────────────────────────
// vault — PDA(["vault", market, mint], PHOENIX_PROGRAM)
//
// Each market has two vaults (base + quote). Created+initialized by
// Phoenix itself during InitializeMarket.
// ─────────────────────────────────────────────────────────────────────

export function deriveVaultPda(marketBs58: string, mintBs58: string): Hex {
  const market = new PublicKey(marketBs58);
  const mint = new PublicKey(mintBs58);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), market.toBuffer(), mint.toBuffer()],
    PHOENIX_PROGRAM_PK,
  );
  return pubkeyToBytes32(pda);
}

// ─────────────────────────────────────────────────────────────────────
// seat — PDA(["seat", market, trader], PHOENIX_PROGRAM)
//
// Required for PlaceLimitOrder. NOT required for Swap (tag 0); the swap
// processor uses `load_post_disallowed` which doesn't read a seat.
// We expose this for completeness.
// ─────────────────────────────────────────────────────────────────────

export function deriveSeatPda(marketBs58: string, traderBs58: string): Hex {
  const market = new PublicKey(marketBs58);
  const trader = new PublicKey(traderBs58);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('seat'), market.toBuffer(), trader.toBuffer()],
    PHOENIX_PROGRAM_PK,
  );
  return pubkeyToBytes32(pda);
}
