// Orca Whirlpool PDA derivations for swap calldata.
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md
// (Family 3 — Orca Whirlpool swap).

import { PublicKey } from '@solana/web3.js';
import type { Hex } from 'viem';
import { bytes32ToPublicKey, pubkeyToBytes32 } from './solana-pda';
import {
  ORACLE_SEED,
  TICK_ARRAY_SEED,
  TICK_ARRAY_SIZE,
  WHIRLPOOL_PROGRAM,
} from './orca-program';

/// Compute the start tick index of the tick array containing `tick`.
/// Uses floor division semantics for negative ticks (matches the
/// on-chain program's logic in `programs/whirlpool/src/util/util.rs`).
///
/// e.g. tickSpacing=1, tick=-45761:
///   ticksInArray = 88 * 1 = 88
///   start = floor(-45761 / 88) * 88 = -521 * 88 = -45848
export function startTickIndex(tick: number, tickSpacing: number): number {
  const ticksInArray = TICK_ARRAY_SIZE * tickSpacing;
  // JS Math.floor handles negatives correctly: Math.floor(-45761/88) = -521
  return Math.floor(tick / ticksInArray) * ticksInArray;
}

/// Derive the tick_array PDA for a (whirlpool, start_tick) pair.
/// Seeds: ["tick_array", whirlpool, start_tick_str_ascii].
export function deriveTickArray(args: {
  whirlpool: Hex;
  startTickIndex: number;
}): Hex {
  const program = bytes32ToPublicKey(WHIRLPOOL_PROGRAM);
  const whirlpool = bytes32ToPublicKey(args.whirlpool);
  const startTickStr = Buffer.from(args.startTickIndex.toString(), 'utf8');
  const [pda] = PublicKey.findProgramAddressSync(
    [TICK_ARRAY_SEED, whirlpool.toBuffer(), startTickStr],
    program,
  );
  return pubkeyToBytes32(pda);
}

/// Derive the adaptive-fee oracle PDA for a whirlpool.
/// Seeds: ["oracle", whirlpool].
export function deriveOracle(whirlpoolHex: Hex): Hex {
  const program = bytes32ToPublicKey(WHIRLPOOL_PROGRAM);
  const whirlpool = bytes32ToPublicKey(whirlpoolHex);
  const [pda] = PublicKey.findProgramAddressSync(
    [ORACLE_SEED, whirlpool.toBuffer()],
    program,
  );
  return pubkeyToBytes32(pda);
}

/// Compute the 3 tick array start indices touched by a swap from
/// `currentTick` going in direction `aToB`.
///
/// - When swapping A → B (`aToB=true`): price decreases, ticks decrease.
///   Touch arrays at start, start − step, start − 2·step.
/// - When swapping B → A (`aToB=false`): price increases, ticks increase.
///   Touch arrays at start, start + step, start + 2·step.
export function tickArrayStartIndicesForSwap(args: {
  currentTick: number;
  tickSpacing: number;
  aToB: boolean;
}): [number, number, number] {
  const start = startTickIndex(args.currentTick, args.tickSpacing);
  const step = TICK_ARRAY_SIZE * args.tickSpacing;
  if (args.aToB) {
    return [start, start - step, start - 2 * step];
  }
  return [start, start + step, start + 2 * step];
}
