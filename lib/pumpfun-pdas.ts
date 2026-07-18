// Pump.fun PDA derivations.
//
// Source: github.com/pump-fun/pump-public-docs (idl/pump.json) +
// on-chain verification on Solana devnet (2026-04-25).

import { PublicKey } from '@solana/web3.js';
import type { Hex } from 'viem';
import {
  bytes32ToPublicKey,
  pubkeyToBytes32,
} from './solana-pda';
import {
  BONDING_CURVE_SEED,
  CREATOR_VAULT_SEED,
  PUMP_FUN_PROGRAM,
  USER_VOLUME_ACCUMULATOR_SEED,
} from './pumpfun-program';

// ─────────────────────────────────────────────────────────────────────
// bonding_curve — PDA(["bonding-curve", mint], PUMP_FUN_PROGRAM)
// ─────────────────────────────────────────────────────────────────────

export function deriveBondingCurve(mintHex: Hex): Hex {
  const program = bytes32ToPublicKey(PUMP_FUN_PROGRAM);
  const mint = bytes32ToPublicKey(mintHex);
  const [pda] = PublicKey.findProgramAddressSync(
    [BONDING_CURVE_SEED, mint.toBuffer()],
    program,
  );
  return pubkeyToBytes32(pda);
}

// ─────────────────────────────────────────────────────────────────────
// creator_vault — PDA(["creator-vault", bonding_curve.creator],
// PUMP_FUN_PROGRAM). The creator pubkey is read out of the
// BondingCurve account at offset 49.
// ─────────────────────────────────────────────────────────────────────

export function deriveCreatorVault(creatorHex: Hex): Hex {
  const program = bytes32ToPublicKey(PUMP_FUN_PROGRAM);
  const creator = bytes32ToPublicKey(creatorHex);
  const [pda] = PublicKey.findProgramAddressSync(
    [CREATOR_VAULT_SEED, creator.toBuffer()],
    program,
  );
  return pubkeyToBytes32(pda);
}

// ─────────────────────────────────────────────────────────────────────
// user_volume_accumulator — PDA(["user_volume_accumulator", user],
// PUMP_FUN_PROGRAM). Buy-only.
// ─────────────────────────────────────────────────────────────────────

export function deriveUserVolumeAccumulator(userHex: Hex): Hex {
  const program = bytes32ToPublicKey(PUMP_FUN_PROGRAM);
  const user = bytes32ToPublicKey(userHex);
  const [pda] = PublicKey.findProgramAddressSync(
    [USER_VOLUME_ACCUMULATOR_SEED, user.toBuffer()],
    program,
  );
  return pubkeyToBytes32(pda);
}
