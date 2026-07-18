// Streamflow PDA derivations for create_v2 + withdraw.
//
// Both PDAs are deterministic from (mint, sender, nonce). Reproduced
// here in TS for client-side calldata building, no on-chain reads.
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md
// (Family 8, Phase A — Sprint 1 continued).

import { PublicKey } from '@solana/web3.js';
import type { Hex } from 'viem';
import {
  bytes32ToPublicKey,
  pubkeyToBytes32,
} from './solana-pda';
import {
  STREAMFLOW_PROGRAM,
  STRM_MET_SEED,
  STRM_SEED,
} from './streamflow-program';

/// Encode a u32 nonce as 4 big-endian bytes — matches the on-chain Rust
/// SDK's `nonce.to_be_bytes()` seed convention. (The Streamflow JS
/// SDK has a documented LE/BE inconsistency — Rust SDK's BE wins
/// because it's what the on-chain program checks. Use nonce ≤ 255 for
/// the first integration to sidestep ambiguity entirely.)
export function nonceToBeBytes(nonce: number): Buffer {
  if (!Number.isInteger(nonce) || nonce < 0 || nonce > 0xffffffff) {
    throw new Error(`streamflow nonce out of u32 range: ${nonce}`);
  }
  const b = Buffer.alloc(4);
  b.writeUInt32BE(nonce, 0);
  return b;
}

/// Derive metadata PDA: PDA(["strm-met", mint, sender, nonce_be4], program).
export function deriveStreamMetadata(args: {
  mint: Hex;
  sender: Hex;
  nonce: number;
}): Hex {
  const program = bytes32ToPublicKey(STREAMFLOW_PROGRAM);
  const mint = bytes32ToPublicKey(args.mint);
  const sender = bytes32ToPublicKey(args.sender);
  const [pda] = PublicKey.findProgramAddressSync(
    [STRM_MET_SEED, mint.toBuffer(), sender.toBuffer(), nonceToBeBytes(args.nonce)],
    program,
  );
  return pubkeyToBytes32(pda);
}

/// Derive escrow tokens PDA: PDA(["strm", metadata], program).
export function deriveEscrowTokens(metadataHex: Hex): Hex {
  const program = bytes32ToPublicKey(STREAMFLOW_PROGRAM);
  const metadata = bytes32ToPublicKey(metadataHex);
  const [pda] = PublicKey.findProgramAddressSync(
    [STRM_SEED, metadata.toBuffer()],
    program,
  );
  return pubkeyToBytes32(pda);
}
