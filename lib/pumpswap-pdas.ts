// PumpSwap PDA derivations.
//
// Source: github.com/pump-fun/pump-public-docs (idl/pump_amm.json)
// + on-chain verification on Solana devnet (2026-04-25).
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md

import { PublicKey } from '@solana/web3.js';
import type { Hex } from 'viem';
import {
  bytes32ToPublicKey,
  pubkeyToBytes32,
} from './solana-pda';
import {
  CREATOR_VAULT_SEED,
  EVENT_AUTHORITY_SEED,
  GLOBAL_VOLUME_ACCUMULATOR_SEED,
  PUMPSWAP_PROGRAM,
  USER_VOLUME_ACCUMULATOR_SEED,
} from './pumpswap-program';

// ─────────────────────────────────────────────────────────────────────
// event_authority — PDA(["__event_authority"], PUMPSWAP_PROGRAM)
// ─────────────────────────────────────────────────────────────────────

export function deriveEventAuthority(): Hex {
  const program = bytes32ToPublicKey(PUMPSWAP_PROGRAM);
  const [pda] = PublicKey.findProgramAddressSync([EVENT_AUTHORITY_SEED], program);
  return pubkeyToBytes32(pda);
}

// ─────────────────────────────────────────────────────────────────────
// coin_creator_vault_authority — PDA(["creator_vault", coin_creator], PUMPSWAP_PROGRAM)
//
// `coin_creator` is read out of the Pool struct. When the field is the
// system program (`11111…111`) the pool has no creator royalty; the
// derivation is still valid and used as-is.
// ─────────────────────────────────────────────────────────────────────

export function deriveCoinCreatorVaultAuthority(coinCreatorHex: Hex): Hex {
  const program = bytes32ToPublicKey(PUMPSWAP_PROGRAM);
  const creator = bytes32ToPublicKey(coinCreatorHex);
  const [pda] = PublicKey.findProgramAddressSync(
    [CREATOR_VAULT_SEED, creator.toBuffer()],
    program,
  );
  return pubkeyToBytes32(pda);
}

// ─────────────────────────────────────────────────────────────────────
// global_volume_accumulator — singleton PDA, used only by `buy`.
// ─────────────────────────────────────────────────────────────────────

export function deriveGlobalVolumeAccumulator(): Hex {
  const program = bytes32ToPublicKey(PUMPSWAP_PROGRAM);
  const [pda] = PublicKey.findProgramAddressSync(
    [GLOBAL_VOLUME_ACCUMULATOR_SEED],
    program,
  );
  return pubkeyToBytes32(pda);
}

// ─────────────────────────────────────────────────────────────────────
// user_volume_accumulator — per-user PDA, used only by `buy`.
// PDA(["user_volume_accumulator", user_pubkey], PUMPSWAP_PROGRAM).
// ─────────────────────────────────────────────────────────────────────

export function deriveUserVolumeAccumulator(userHex: Hex): Hex {
  const program = bytes32ToPublicKey(PUMPSWAP_PROGRAM);
  const user = bytes32ToPublicKey(userHex);
  const [pda] = PublicKey.findProgramAddressSync(
    [USER_VOLUME_ACCUMULATOR_SEED, user.toBuffer()],
    program,
  );
  return pubkeyToBytes32(pda);
}
