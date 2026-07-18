// Phoenix Swap (tag 0) invoke builder.
//
// Phoenix's `Swap` ix takes 9 accounts in this order
// (src/program/instruction.rs, PhoenixInstruction::Swap):
//
//   0. phoenix_program        (readonly)             ← program id itself
//   1. log_authority          (readonly)             ← global PDA
//   2. market                 (writable)
//   3. trader                 (signer)               ← user's Rome PDA
//   4. base_account           (writable)             ← user's WSOL ATA
//   5. quote_account          (writable)             ← user's USDC ATA
//   6. base_vault             (writable)             ← market PDA
//   7. quote_vault            (writable)             ← market PDA
//   8. token_program          (readonly)
//
// Args (after the 1-byte tag = 0):
//   OrderPacket::ImmediateOrCancel { … }, Borsh-encoded.
//
// Variant disc for ImmediateOrCancel = 2 (PostOnly=0, Limit=1, IOC=2).
//
// IOC field layout (src/state/order_schema/order_packet.rs):
//   side                              u8           Bid=0, Ask=1
//   price_in_ticks                    Option<u64>  None=0x00 → market order
//   num_base_lots                     u64
//   num_quote_lots                    u64
//   min_base_lots_to_fill             u64          slippage guard (sells)
//   min_quote_lots_to_fill            u64          slippage guard (buys)
//   self_trade_behavior               u8           0=Abort, 1=CancelProvide, 2=DecrementTake
//   match_limit                       Option<u64>  None=0x00 → unlimited
//   client_order_id                   u128
//   use_only_deposited_funds          bool         must be false for non-seat traders
//   last_valid_slot                   Option<u64>  None=0x00
//   last_valid_unix_timestamp_in_secs Option<u64>  None=0x00

import { concat, type Address, type Hex } from 'viem';
import type { AccountMeta } from './cpi-precompile';
import { deriveRomeUserPda, deriveAta, pubkeyBs58ToBytes32 } from './solana-pda';
import {
  PHOENIX_PROGRAM,
  TAG_SWAP,
} from './phoenix-program';
import { PHOENIX_LOG_AUTHORITY } from './phoenix-pdas';
import type { PhoenixMarketEntry } from './phoenix-markets';

const SPL_TOKEN_PROGRAM_HEX: Hex = pubkeyBs58ToBytes32(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
);

// ─────────────────────────────────────────────────────────────────────
// Borsh-style serialization helpers
// ─────────────────────────────────────────────────────────────────────

function u8Hex(b: number): Hex {
  return ('0x' + (b & 0xff).toString(16).padStart(2, '0')) as Hex;
}

function u64leHex(v: bigint): Hex {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(v, 0);
  return ('0x' + buf.toString('hex')) as Hex;
}

function u128leHex(v: bigint): Hex {
  const lo = v & 0xffffffffffffffffn;
  const hi = (v >> 64n) & 0xffffffffffffffffn;
  return concat([u64leHex(lo), u64leHex(hi)]) as Hex;
}

function optU64leHex(v: bigint | null): Hex {
  return v === null ? u8Hex(0) : (concat([u8Hex(1), u64leHex(v)]) as Hex);
}

// ─────────────────────────────────────────────────────────────────────
// Side constants.
// ─────────────────────────────────────────────────────────────────────

export const SIDE_BID = 0; // user pays quote (USDC), receives base (WSOL)
export const SIDE_ASK = 1; // user pays base (WSOL), receives quote (USDC)

// ─────────────────────────────────────────────────────────────────────
// SelfTradeBehavior.
// ─────────────────────────────────────────────────────────────────────

const SELF_TRADE_ABORT = 0;

// ─────────────────────────────────────────────────────────────────────
// IOC encoder
// ─────────────────────────────────────────────────────────────────────

function encodeIocOrder(args: {
  side: number;
  /// `null` → market order with no price limit.
  priceInTicks: bigint | null;
  numBaseLots: bigint;
  numQuoteLots: bigint;
  /// Slippage guard for sells: fail if order fills < this many base lots.
  minBaseLotsToFill: bigint;
  /// Slippage guard for buys: fail if order fills < this many quote lots.
  minQuoteLotsToFill: bigint;
}): Hex {
  return concat([
    u8Hex(2), // IOC variant disc
    u8Hex(args.side),
    optU64leHex(args.priceInTicks),
    u64leHex(args.numBaseLots),
    u64leHex(args.numQuoteLots),
    u64leHex(args.minBaseLotsToFill),
    u64leHex(args.minQuoteLotsToFill),
    u8Hex(SELF_TRADE_ABORT),
    u8Hex(0),                     // match_limit None
    u128leHex(0n),                // client_order_id
    u8Hex(0),                     // use_only_deposited_funds=false
    u8Hex(0),                     // last_valid_slot None
    u8Hex(0),                     // last_valid_unix_timestamp None
  ]) as Hex;
}

// ─────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────

export type PhoenixSwapAddresses = {
  user: Hex;
  marketAddress: Hex;
  logAuthority: Hex;
  baseMint: Hex;
  quoteMint: Hex;
  baseVault: Hex;
  quoteVault: Hex;
  userBaseAta: Hex;
  userQuoteAta: Hex;
  tokenProgram: Hex;
};

export type PhoenixSwapInvoke = {
  program: Hex;
  accounts: AccountMeta[];
  data: Hex;
  addresses: PhoenixSwapAddresses;
};

// ─────────────────────────────────────────────────────────────────────
// Build a Phoenix `Swap` IOC invoke.
//
// `inputIsBase` selects direction:
//   true  → user spends base (WSOL), wants quote (USDC) → side = ASK
//   false → user spends quote (USDC), wants base (WSOL) → side = BID
//
// For asks (selling base), `numBaseLots` is the input budget.
// For bids (buying base), `numQuoteLots` is the input budget. The
// non-active side stays 0. Slippage guards are encoded in
// `minBaseLotsToFill` / `minQuoteLotsToFill` which we set to the
// caller-supplied minimum-output (in lot units).
// ─────────────────────────────────────────────────────────────────────

export function buildPhoenixSwapInvoke(args: {
  userEvmAddress: Address;
  market: PhoenixMarketEntry;
  /// Whether the user is spending the base mint (WSOL → USDC).
  inputIsBase: boolean;
  /// Input amount in BASE LOTS or QUOTE LOTS depending on direction.
  /// (Use the market header's lot sizes to convert.) Caller is
  /// responsible for ATA balance + slippage planning.
  inputLots: bigint;
  /// Slippage guard. Minimum amount of *output* lots the trade must
  /// fill or it reverts.
  minOutputLots: bigint;
}): PhoenixSwapInvoke {
  const user = deriveRomeUserPda(args.userEvmAddress);
  const userBaseAta = deriveAta(user, args.market.baseMint);
  const userQuoteAta = deriveAta(user, args.market.quoteMint);

  const accounts: AccountMeta[] = [
    { pubkey: PHOENIX_PROGRAM, is_signer: false, is_writable: false },
    { pubkey: PHOENIX_LOG_AUTHORITY, is_signer: false, is_writable: false },
    { pubkey: args.market.marketHex, is_signer: false, is_writable: true },
    { pubkey: user, is_signer: true, is_writable: false },
    { pubkey: userBaseAta, is_signer: false, is_writable: true },
    { pubkey: userQuoteAta, is_signer: false, is_writable: true },
    { pubkey: args.market.baseVault, is_signer: false, is_writable: true },
    { pubkey: args.market.quoteVault, is_signer: false, is_writable: true },
    { pubkey: SPL_TOKEN_PROGRAM_HEX, is_signer: false, is_writable: false },
  ];

  // Side / lot routing.
  // ASK: user supplies base, takes quote. num_base_lots = inputLots,
  //      num_quote_lots = 0, min_quote_lots_to_fill = minOutputLots.
  // BID: user supplies quote, takes base. num_quote_lots = inputLots,
  //      num_base_lots = 0, min_base_lots_to_fill = minOutputLots.
  const side = args.inputIsBase ? SIDE_ASK : SIDE_BID;
  const numBaseLots = args.inputIsBase ? args.inputLots : 0n;
  const numQuoteLots = args.inputIsBase ? 0n : args.inputLots;
  const minBaseLotsToFill = args.inputIsBase ? 0n : args.minOutputLots;
  const minQuoteLotsToFill = args.inputIsBase ? args.minOutputLots : 0n;

  const orderPacket = encodeIocOrder({
    side,
    priceInTicks: null, // market order — let it cross at any price
    numBaseLots,
    numQuoteLots,
    minBaseLotsToFill,
    minQuoteLotsToFill,
  });

  const data = concat([u8Hex(TAG_SWAP), orderPacket]) as Hex;

  return {
    program: PHOENIX_PROGRAM,
    accounts,
    data,
    addresses: {
      user,
      marketAddress: args.market.marketHex,
      logAuthority: PHOENIX_LOG_AUTHORITY,
      baseMint: args.market.baseMint,
      quoteMint: args.market.quoteMint,
      baseVault: args.market.baseVault,
      quoteVault: args.market.quoteVault,
      userBaseAta,
      userQuoteAta,
      tokenProgram: SPL_TOKEN_PROGRAM_HEX,
    },
  };
}
