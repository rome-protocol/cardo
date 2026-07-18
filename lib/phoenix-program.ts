// Phoenix v1 CLOB program constants for the Cardo `/swap-phoenix`
// integration.
//
// **Source of truth**: github.com/Ellipsis-Labs/phoenix-v1.
// Phoenix's instruction format is hand-rolled (NOT Anchor): a single
// u8 tag byte followed by a Borsh-serialized argument struct.
//
// Devnet bootstrap state (verified live 2026-04-26):
//   - Program (PhoeNiXZ8…)            executable=true ✓
//   - Single Cardo-owned market for canonical WSOL ↔ USDC-devnet at
//     `613nNZ8zyBLQVBCybeKBU3kfETTuNKJjEVwgBTiJ2jCP`.
//     Init+seed sigs are pinned in `phoenix-markets.ts`.

import type { Hex } from 'viem';
import { pubkeyBs58ToBytes32 } from './solana-pda';
import { solanaProgramId } from './solana-programs';

// ─────────────────────────────────────────────────────────────────────
// Program id (from @rome-protocol/registry) + log-authority PDA
//
// Phoenix has a single global log-authority PDA derived from
// `["log"]` against the program id. It's referenced (read-only) by every
// Phoenix instruction so it can append events via inner-ix Log calls.
// ─────────────────────────────────────────────────────────────────────

export const PHOENIX_PROGRAM: Hex = pubkeyBs58ToBytes32(
  solanaProgramId('phoenix', 'devnet'),
);

export const PHOENIX_PROGRAM_BS58 =
  'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY' as const;

// Hardcoded ID is asserted by the Phoenix source-tree test
// `phoenix_log_authority::check_pda` which derives PDA(["log"], program).
// We re-derive in `phoenix-pdas.ts` and pin the result here.
export const PHOENIX_LOG_AUTHORITY_BS58 =
  '7aDTsspkQNGKmrexAN7FLx9oxU3iPczSSvHNggyuqYkR' as const;

// ─────────────────────────────────────────────────────────────────────
// Instruction tags (src/program/instruction.rs `PhoenixInstruction`)
//
// Single-byte tag prepended to Borsh-encoded arguments. The
// account-list shape changes per tag — see phoenix-instructions.ts for
// the Swap layout (tag 0).
// ─────────────────────────────────────────────────────────────────────

export const TAG_SWAP = 0;
export const TAG_PLACE_LIMIT_ORDER = 2;
export const TAG_INITIALIZE_MARKET = 100;
export const TAG_CHANGE_MARKET_STATUS = 103;
export const TAG_CHANGE_SEAT_STATUS = 104;
export const TAG_REQUEST_SEAT_AUTHORIZED = 105;

// ─────────────────────────────────────────────────────────────────────
// MarketHeader layout (src/program/accounts.rs MarketHeader, 576 bytes)
//
// Layout (offsets in raw account data buffer):
//   0..8     discriminant      u64 LE  (= 0x715820b77371df77)
//   8..16    status            u64 LE  (1=Active, 2=PostOnly, …)
//   16..40   market_size_params (24): bids_size, asks_size, num_seats
//   40..48   base_decimals     u32 (4) + base_vault_bump u32 (4)
//   48..80   base_mint         pubkey
//   80..112  base_vault        pubkey
//   112..120 base_lot_size     u64 LE
//   120..128 quote_decimals    u32 + quote_vault_bump u32
//   128..160 quote_mint        pubkey
//   160..192 quote_vault       pubkey
//   192..200 quote_lot_size    u64 LE
//   200..208 tick_size_in_quote_atoms_per_base_unit u64 LE
//   208..240 authority         pubkey
//   240..272 fee_recipient     pubkey
//   272..280 market_sequence_number u64 LE
//   280..312 successor         pubkey
//   312..316 raw_base_units_per_base_unit u32 LE
//   316..320 _padding1         u32
//   320..576 _padding2         [u64; 32]
//
// Verified live against bootstrap target market `613nNZ8z…`
// (tx1: 2hxtccA9Q…) — discriminant + status both readable at the
// expected offsets.
// ─────────────────────────────────────────────────────────────────────

export const MARKET_HEADER_DISC: bigint = 0x715820b77371df77n;
export const MARKET_HEADER_SIZE = 576;

// CU budget. Phoenix swap is ~9 accounts and runs the matching engine
// over an FIFO orderbook; empirical estimate based on Phoenix mainnet
// telemetry (typical IOC ~85k–110k CU). Bumped for Rome's CPI overhead.
export const CU_PHOENIX_SWAP = 120_000n;
