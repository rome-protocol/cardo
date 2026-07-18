// DAMM v2 PDA derivations.
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md

import { PublicKey } from '@solana/web3.js';
import type { Hex } from 'viem';
import { bytes32ToPublicKey, pubkeyToBytes32 } from './solana-pda';
import {
  DAMM_V2_PROGRAM,
  EVENT_AUTHORITY_SEED,
  POSITION_SEED,
} from './damm-v2-program';

/// Derive the program's event authority PDA.
/// PDA(["__event_authority"], DAMM_V2_PROGRAM).
export function deriveDammV2EventAuthority(): Hex {
  const program = bytes32ToPublicKey(DAMM_V2_PROGRAM);
  const [pda] = PublicKey.findProgramAddressSync(
    [EVENT_AUTHORITY_SEED],
    program,
  );
  return pubkeyToBytes32(pda);
}

/// Derive the Position PDA from its NFT mint.
/// PDA([b"position", positionNftMint], DAMM_V2_PROGRAM).
export function deriveDammV2Position(positionNftMintHex: Hex): Hex {
  const program = bytes32ToPublicKey(DAMM_V2_PROGRAM);
  const mint = bytes32ToPublicKey(positionNftMintHex);
  const [pda] = PublicKey.findProgramAddressSync(
    [POSITION_SEED, mint.toBuffer()],
    program,
  );
  return pubkeyToBytes32(pda);
}
