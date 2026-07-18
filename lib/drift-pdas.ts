// Drift v2 PDA derivations.
//
// All PDAs are deterministic from (authority, market_index, sub_account_id).
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md

import { PublicKey } from '@solana/web3.js';
import type { Hex } from 'viem';
import { bytes32ToPublicKey, pubkeyToBytes32 } from './solana-pda';
import {
  DRIFT_PROGRAM,
  DRIFT_SIGNER_SEED,
  DRIFT_STATE_SEED,
  SPOT_MARKET_SEED,
  USER_SEED,
  USER_STATS_SEED,
} from './drift-program';

/// Encode u16 as 2 little-endian bytes.
function u16Le(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new Error(`u16 out of range: ${value}`);
  }
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value, 0);
  return b;
}

/// Derive Drift's State PDA.
export function deriveDriftState(): Hex {
  const program = bytes32ToPublicKey(DRIFT_PROGRAM);
  const [pda] = PublicKey.findProgramAddressSync([DRIFT_STATE_SEED], program);
  return pubkeyToBytes32(pda);
}

/// Derive Drift's signer PDA (pool authority).
export function deriveDriftSigner(): Hex {
  const program = bytes32ToPublicKey(DRIFT_PROGRAM);
  const [pda] = PublicKey.findProgramAddressSync([DRIFT_SIGNER_SEED], program);
  return pubkeyToBytes32(pda);
}

/// Derive a user's `User` account for a sub-account id.
/// PDA(["user", authority, u16_le(sub_account_id)], DRIFT).
export function deriveDriftUser(args: {
  authority: Hex;
  subAccountId: number;
}): Hex {
  const program = bytes32ToPublicKey(DRIFT_PROGRAM);
  const auth = bytes32ToPublicKey(args.authority);
  const [pda] = PublicKey.findProgramAddressSync(
    [USER_SEED, auth.toBuffer(), u16Le(args.subAccountId)],
    program,
  );
  return pubkeyToBytes32(pda);
}

/// Derive a user's `UserStats` account.
/// PDA(["user_stats", authority], DRIFT).
export function deriveDriftUserStats(authorityHex: Hex): Hex {
  const program = bytes32ToPublicKey(DRIFT_PROGRAM);
  const auth = bytes32ToPublicKey(authorityHex);
  const [pda] = PublicKey.findProgramAddressSync(
    [USER_STATS_SEED, auth.toBuffer()],
    program,
  );
  return pubkeyToBytes32(pda);
}

/// Derive a SpotMarket PDA.
/// PDA(["spot_market", u16_le(market_index)], DRIFT).
export function deriveSpotMarket(marketIndex: number): Hex {
  const program = bytes32ToPublicKey(DRIFT_PROGRAM);
  const [pda] = PublicKey.findProgramAddressSync(
    [SPOT_MARKET_SEED, u16Le(marketIndex)],
    program,
  );
  return pubkeyToBytes32(pda);
}
