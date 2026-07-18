// Phoenix market registry + MarketHeader decoder + indicative quote.
//
// Source: github.com/Ellipsis-Labs/phoenix-v1, src/program/accounts.rs.
//
// Cardo runs a single Phoenix market on devnet today, bootstrapped via
// `scripts/bootstrap-phoenix-market.ts` against canonical WSOL +
// Circle USDC-devnet. The market keypair lives in
// `scripts/keys/phoenix-market.priv.json` (gitignored) so the bootstrap
// is replayable, but the addresses below are pinned because
// re-running the bootstrap produces a fresh market — the registry
// chooses one canonical instance.

import type { Hex } from 'viem';
import { PublicKey } from '@solana/web3.js';
import { pubkeyBs58ToBytes32 } from './solana-pda';
import {
  MARKET_HEADER_DISC,
  MARKET_HEADER_SIZE,
} from './phoenix-program';
import { deriveVaultPda } from './phoenix-pdas';

// ─────────────────────────────────────────────────────────────────────
// Decoded MarketHeader (subset that the UI needs)
// ─────────────────────────────────────────────────────────────────────

export type PhoenixMarketHeader = {
  /// MarketStatus: 0=Uninitialized, 1=Active, 2=PostOnly, 3=Paused,
  /// 4=Closed, 5=Tombstoned. Cardo's swap path requires Active.
  status: bigint;
  bidsSize: bigint;
  asksSize: bigint;
  numSeats: bigint;
  baseDecimals: number;
  baseMint: Hex;
  baseVault: Hex;
  baseLotSize: bigint;
  quoteDecimals: number;
  quoteMint: Hex;
  quoteVault: Hex;
  quoteLotSize: bigint;
  /// tick_size_in_quote_atoms_per_base_unit — convert ticks to a
  /// human price via this factor.
  tickSizeInQuoteAtomsPerBaseUnit: bigint;
  authority: Hex;
  feeRecipient: Hex;
  marketSequenceNumber: bigint;
  successor: Hex;
  rawBaseUnitsPerBaseUnit: number;
};

function readPubkeyHex(buf: Buffer, off: number): Hex {
  return ('0x' + buf.subarray(off, off + 32).toString('hex')) as Hex;
}

export function decodePhoenixMarketHeader(data: Buffer): PhoenixMarketHeader {
  if (data.length < MARKET_HEADER_SIZE) {
    throw new Error(
      `phoenix market data too short: got ${data.length}, want >= ${MARKET_HEADER_SIZE}`,
    );
  }
  const disc = data.readBigUInt64LE(0);
  if (disc !== MARKET_HEADER_DISC) {
    throw new Error(
      `phoenix market disc mismatch: got 0x${disc.toString(16)}, want 0x${MARKET_HEADER_DISC.toString(16)}`,
    );
  }
  return {
    status: data.readBigUInt64LE(8),
    bidsSize: data.readBigUInt64LE(16),
    asksSize: data.readBigUInt64LE(24),
    numSeats: data.readBigUInt64LE(32),
    // TokenParams base: decimals u32 @ 40, vault_bump u32 @ 44
    baseDecimals: data.readUInt32LE(40),
    baseMint: readPubkeyHex(data, 48),
    baseVault: readPubkeyHex(data, 80),
    baseLotSize: data.readBigUInt64LE(112),
    // TokenParams quote: decimals u32 @ 120, vault_bump u32 @ 124
    quoteDecimals: data.readUInt32LE(120),
    quoteMint: readPubkeyHex(data, 128),
    quoteVault: readPubkeyHex(data, 160),
    quoteLotSize: data.readBigUInt64LE(192),
    tickSizeInQuoteAtomsPerBaseUnit: data.readBigUInt64LE(200),
    authority: readPubkeyHex(data, 208),
    feeRecipient: readPubkeyHex(data, 240),
    marketSequenceNumber: data.readBigUInt64LE(272),
    successor: readPubkeyHex(data, 280),
    rawBaseUnitsPerBaseUnit: data.readUInt32LE(312),
  };
}

// ─────────────────────────────────────────────────────────────────────
// fetchPhoenixMarket — getAccountInfo + decode.
// ─────────────────────────────────────────────────────────────────────

export async function fetchPhoenixMarket(
  rpcUrl: string,
  marketBs58: string,
): Promise<PhoenixMarketHeader> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getAccountInfo',
      params: [marketBs58, { encoding: 'base64' }],
    }),
  });
  const json = await res.json();
  const value = json?.result?.value;
  if (!value) {
    throw new Error(`phoenix: market ${marketBs58} not found on this RPC`);
  }
  const buf = Buffer.from(value.data[0], 'base64');
  return decodePhoenixMarketHeader(buf);
}

// ─────────────────────────────────────────────────────────────────────
// Curated registry
//
// Bootstrap (verified live 2026-04-26 via api.devnet.solana.com):
//   tx1 (init+activate): 2hxtccA9Qu3zr3dFUwKPrVNUrXgTuZXD8egD3uQbnKKJXJn3vYikgb7Z9rHv2wVrz83RuYSz4KtsWygwKtgTRUy9
//   tx4 (ask seed):      2EBV8UBPtAHNcdSpRQQQ7D5jnzmRq1eaMTdHPjpLrHgYrSGzkfxryuR3qWTYA2KRBmNP17RmvBoCZGBAA8qqy7Pv
//   tx5 (bid seed):      31fNCJidf7sjhh3xpYChJCT8PTChC9hAxXUQynKqFF58u92oDh6wBMcmAVZY1otdCg2fddMXyFYE1GtCNbvQPy5y
// Final state:
//   - market disc       = 0x715820b77371df77 ✓
//   - market status     = 1 (Active) ✓
//   - base_vault holds  0.05 WSOL (one resting ask @ 1100 ticks)
//   - quote_vault holds 4.50 USDC (one resting bid @ 900 ticks)
// ─────────────────────────────────────────────────────────────────────

export type PhoenixMarketEntry = {
  /// Display label (e.g. "WSOL ↔ USDC · devnet").
  label: string;
  /// Market account bs58.
  marketBs58: string;
  /// Market account hex (bytes32).
  marketHex: Hex;
  /// Base mint hex (typically the larger / "base" — WSOL here).
  baseMint: Hex;
  /// Quote mint hex (USDC devnet here).
  quoteMint: Hex;
  /// Base vault PDA hex.
  baseVault: Hex;
  /// Quote vault PDA hex.
  quoteVault: Hex;
  /// SPL Token program hex (classic for both sides on this market).
  baseTokenProgram: Hex;
  quoteTokenProgram: Hex;
  /// Mint decimals (cached from the market header to avoid an extra RPC
  /// in the price math).
  baseDecimals: number;
  quoteDecimals: number;
  /// Network the market lives on.
  network: 'devnet' | 'mainnet';
  enabled: boolean;
};

const SPL_TOKEN_PROGRAM_HEX: Hex = pubkeyBs58ToBytes32(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
);

const WSOL_USDC_DEVNET: PhoenixMarketEntry = {
  label: 'WSOL ↔ USDC · devnet',
  marketBs58: '613nNZ8zyBLQVBCybeKBU3kfETTuNKJjEVwgBTiJ2jCP',
  marketHex: pubkeyBs58ToBytes32(
    '613nNZ8zyBLQVBCybeKBU3kfETTuNKJjEVwgBTiJ2jCP',
  ),
  baseMint: pubkeyBs58ToBytes32(
    'So11111111111111111111111111111111111111112',
  ),
  quoteMint: pubkeyBs58ToBytes32(
    '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  ),
  // Vaults are derived but pinned for clarity.
  baseVault: deriveVaultPda(
    '613nNZ8zyBLQVBCybeKBU3kfETTuNKJjEVwgBTiJ2jCP',
    'So11111111111111111111111111111111111111112',
  ),
  quoteVault: deriveVaultPda(
    '613nNZ8zyBLQVBCybeKBU3kfETTuNKJjEVwgBTiJ2jCP',
    '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  ),
  baseTokenProgram: SPL_TOKEN_PROGRAM_HEX,
  quoteTokenProgram: SPL_TOKEN_PROGRAM_HEX,
  baseDecimals: 9,
  quoteDecimals: 6,
  network: 'devnet',
  enabled: true,
} as const;

export const PHOENIX_MARKET_REGISTRY: ReadonlyArray<PhoenixMarketEntry> = [
  WSOL_USDC_DEVNET,
];

export const ENABLED_PHOENIX_MARKETS: ReadonlyArray<PhoenixMarketEntry> =
  PHOENIX_MARKET_REGISTRY.filter((m) => m.enabled);

// ─────────────────────────────────────────────────────────────────────
// Indicative price derived from the market header alone.
//
// `tick_size_in_quote_atoms_per_base_unit` tells us how many quote
// atoms (e.g. USDC micro-units) one tick represents per *base unit*
// (1 SOL). Combined with raw_base_units_per_base_unit (= 1 here) this
// gives a $/SOL price for any given tick.
//
// The seeded book has a 1100-tick ask + 900-tick bid. We can't tell the
// best-bid / best-ask without parsing the FIFO order tree (256-bit
// critbit nodes spread across ~85 KB of account data). For this
// preview-quality UI we just expose the lot/tick-size scaling and let
// the screen show "indicative — fills at IOC market price".
// ─────────────────────────────────────────────────────────────────────

export function tickToPriceFloat(
  header: PhoenixMarketHeader,
  ticks: bigint,
): number {
  // Price per base unit in quote atoms.
  const quoteAtoms = ticks * header.tickSizeInQuoteAtomsPerBaseUnit;
  // Convert base unit (1 SOL) and quote atoms (USDC micros) to floats.
  // raw_base_units_per_base_unit defaults to 1 so 1 base unit = 10^base_decimals atoms.
  const quoteFloat = Number(quoteAtoms) / 10 ** header.quoteDecimals;
  return quoteFloat / header.rawBaseUnitsPerBaseUnit;
}

export function baseLotsToFloat(
  header: PhoenixMarketHeader,
  lots: bigint,
): number {
  const atoms = lots * header.baseLotSize;
  return Number(atoms) / 10 ** header.baseDecimals;
}

export function quoteLotsToFloat(
  header: PhoenixMarketHeader,
  lots: bigint,
): number {
  const atoms = lots * header.quoteLotSize;
  return Number(atoms) / 10 ** header.quoteDecimals;
}
