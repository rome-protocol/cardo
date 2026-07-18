// Bootstrap a Phoenix CLOB market on Solana devnet for canonical
// WSOL ↔ USDC-devnet, then seed both sides with resting limit orders so
// the Cardo /swap-phoenix flow has a real book to take liquidity from.
//
// Source of truth:
//   github.com/Ellipsis-Labs/phoenix-v1
//   src/program/processor/initialize.rs
//   src/program/instruction.rs (account list + tag bytes)
//   src/program/instruction_builders/market_authority_instructions.rs
//   src/program/dispatch_market.rs (market size table, smallest is
//     bids=512, asks=512, num_seats=128 → 84,944 bytes raw)
//
// Phoenix's `InitializeMarket` is permissionless — anyone can spin up a
// market at the cost of one rent-exempt account (~0.59 SOL for the
// smallest size). Vaults are PDAs (seeds: [b"vault", market, mint]) so
// the program signs vault creation itself; the market account is a
// fresh keypair created via SystemProgram::create_account in the same tx.
//
// Bootstrap steps:
//
//   tx1: create_account(market) + InitializeMarket + ChangeMarketStatus(Active)
//        — creates the market PostOnly, then flips to Active so swaps work.
//   tx2: RequestSeatAuthorized(treasury as authority + payer + trader)
//        — every limit-order placer needs a seat (PDA on the market).
//        Authority can request directly with one ix vs the
//        permissionless RequestSeat which creates NotApproved + needs
//        ChangeSeatStatus.
//   tx3: ChangeSeatStatus(Approved)  — flip the new seat to Approved.
//   tx4: SyncNative on treasury's WSOL ATA + PlaceLimitOrder ASK
//        — sells 0.05 SOL @ 110 USDC/SOL = 5.5 USDC.
//   tx5: PlaceLimitOrder BID
//        — buys at 90 USDC/SOL with up to 4.5 USDC = 0.05 SOL bid.
//
// Why these prices: 110 ask + 90 bid leaves a $20 spread at $100 mid —
// generous so a small swap won't move price meaningfully. The intent is
// liveness, not price discovery; nothing depends on this being tight.
//
// Run:
//   npx tsx scripts/bootstrap-phoenix-market.ts

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  NATIVE_MINT,
} from '@solana/spl-token';
import * as fs from 'fs';
import * as path from 'path';

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

const RPC_URL = 'https://api.devnet.solana.com';

const PHOENIX_PROGRAM_ID = new PublicKey(
  'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY',
);
const PHOENIX_LOG_AUTHORITY = new PublicKey(
  '7aDTsspkQNGKmrexAN7FLx9oxU3iPczSSvHNggyuqYkR',
);

const BASE_MINT = NATIVE_MINT; // So11111111111111111111111111111111111111112 (WSOL)
const QUOTE_MINT = new PublicKey(
  '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', // Circle USDC devnet
);

const TREASURY_KEYPAIR_PATH =
  '$HOME/rome/.secrets/e2e/treasury-solana.json';

// ─────────────────────────────────────────────────────────────────────
// Phoenix instruction tags (src/program/instruction.rs)
// ─────────────────────────────────────────────────────────────────────

const TAG_PLACE_LIMIT_ORDER = 2;
const TAG_INITIALIZE_MARKET = 100;
const TAG_CHANGE_MARKET_STATUS = 103;
const TAG_REQUEST_SEAT_AUTHORIZED = 105;
const TAG_CHANGE_SEAT_STATUS = 104;

// ─────────────────────────────────────────────────────────────────────
// Market sizing
//
// Smallest valid config (bids=512, asks=512, num_seats=128) → live
// devnet markets at this size report `space=84_944`. Verified via
// `getProgramAccounts` filter against PhoeNiXZ… on api.devnet.solana.com.
// ─────────────────────────────────────────────────────────────────────

const MARKET_SPACE = 84_944;
const BIDS_SIZE = 512n;
const ASKS_SIZE = 512n;
const NUM_SEATS = 128n;

// Lot sizes:
//   base_mint = WSOL, decimals 9. Set base_lot_size = 0.001 SOL = 1e6 lamports.
//     → num_base_lots_per_base_unit = 1e9 / 1e6 = 1000.
//   quote_mint = USDC devnet, decimals 6. Set quote_lot_size = $0.0001 = 100 micros.
//     → num_quote_lots_per_quote_unit = 1e6 / 100 = 10_000.
//   tick_size = $0.01 per base unit = 100 quote_lots per base unit.
//     Constraint check: tick % num_base_lots_per_base_unit must be 0
//     (Phoenix's "T divides B" rule). 100 / 1000 — fails.
//
// Recompute tick: tick_size = $0.10 per base unit = 1000 quote lots per base.
// 1000 / 1000 = 1 ✓ (any tick that's a multiple of 1000 works).
//
// Result: 0.10 USDC tick on a SOL/USDC market — good enough for $100/SOL
// where $0.10 spread granularity is far inside any expected slippage on
// a 0.001 SOL trade.

const NUM_BASE_LOTS_PER_BASE_UNIT = 1000n;        // SOL → 0.001 SOL lots
const NUM_QUOTE_LOTS_PER_QUOTE_UNIT = 10_000n;    // USDC → $0.0001 lots
const TICK_SIZE_IN_QUOTE_LOTS_PER_BASE_UNIT = 1000n; // $0.10 ticks
const TAKER_FEE_BPS = 0;                          // no taker fee on devnet
const RAW_BASE_UNITS_PER_BASE_UNIT_OPT: number | null = null; // None → 1

// ─────────────────────────────────────────────────────────────────────
// Borsh-style serialization helpers
// ─────────────────────────────────────────────────────────────────────

function u8(b: number): Buffer {
  return Buffer.from([b & 0xff]);
}

function u16le(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v >>> 0, 0);
  return b;
}

function u32le(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0, 0);
  return b;
}

function u64le(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v, 0);
  return b;
}

function u128le(v: bigint): Buffer {
  const lo = v & 0xffffffffffffffffn;
  const hi = (v >> 64n) & 0xffffffffffffffffn;
  return Buffer.concat([u64le(lo), u64le(hi)]);
}

function optU64le(v: bigint | null): Buffer {
  return v === null ? u8(0) : Buffer.concat([u8(1), u64le(v)]);
}

function optU32le(v: number | null): Buffer {
  return v === null ? u8(0) : Buffer.concat([u8(1), u32le(v)]);
}

// ─────────────────────────────────────────────────────────────────────
// Borsh encoding for InitializeParams
//
// struct InitializeParams {
//   market_size_params: MarketSizeParams { bids_size, asks_size, num_seats } // 24
//   num_quote_lots_per_quote_unit: u64                                       // 8
//   tick_size_in_quote_lots_per_base_unit: u64                               // 8
//   num_base_lots_per_base_unit: u64                                         // 8
//   taker_fee_bps: u16                                                       // 2
//   fee_collector: Pubkey                                                    // 32
//   raw_base_units_per_base_unit: Option<u32>                                // 1 or 5
// }
// ─────────────────────────────────────────────────────────────────────

function encodeInitializeParams(feeCollector: PublicKey): Buffer {
  return Buffer.concat([
    u64le(BIDS_SIZE),
    u64le(ASKS_SIZE),
    u64le(NUM_SEATS),
    u64le(NUM_QUOTE_LOTS_PER_QUOTE_UNIT),
    u64le(TICK_SIZE_IN_QUOTE_LOTS_PER_BASE_UNIT),
    u64le(NUM_BASE_LOTS_PER_BASE_UNIT),
    u16le(TAKER_FEE_BPS),
    feeCollector.toBuffer(),
    optU32le(RAW_BASE_UNITS_PER_BASE_UNIT_OPT),
  ]);
}

// ─────────────────────────────────────────────────────────────────────
// Borsh encoding for OrderPacket::PostOnly
//   PostOnly {
//     side: Side                               // u8
//     price_in_ticks: Ticks                    // u64
//     num_base_lots: BaseLots                  // u64
//     client_order_id: u128                    // 16
//     reject_post_only: bool                   // u8
//     use_only_deposited_funds: bool           // u8
//     last_valid_slot: Option<u64>             // 1
//     last_valid_unix_timestamp_in_seconds: Option<u64>  // 1
//     fail_silently_on_insufficient_funds: bool          // u8
//   }
// Variant disc = 0.
// ─────────────────────────────────────────────────────────────────────

const SIDE_BID = 0;
const SIDE_ASK = 1;

function encodePostOnly(args: {
  side: number;
  priceInTicks: bigint;
  numBaseLots: bigint;
}): Buffer {
  return Buffer.concat([
    u8(0), // PostOnly variant
    u8(args.side),
    u64le(args.priceInTicks),
    u64le(args.numBaseLots),
    u128le(0n), // client_order_id
    u8(1),      // reject_post_only=true (default)
    u8(0),      // use_only_deposited_funds=false
    u8(0),      // last_valid_slot=None
    u8(0),      // last_valid_unix_timestamp=None
    u8(0),      // fail_silently_on_insufficient_funds=false
  ]);
}

// ─────────────────────────────────────────────────────────────────────
// PDA helpers
// ─────────────────────────────────────────────────────────────────────

function getVaultPda(market: PublicKey, mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), market.toBuffer(), mint.toBuffer()],
    PHOENIX_PROGRAM_ID,
  );
}

function getSeatPda(market: PublicKey, trader: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('seat'), market.toBuffer(), trader.toBuffer()],
    PHOENIX_PROGRAM_ID,
  );
}

// ─────────────────────────────────────────────────────────────────────
// Phoenix instruction builders
// ─────────────────────────────────────────────────────────────────────

function buildInitializeMarketIx(args: {
  market: PublicKey;
  marketCreator: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  feeCollector: PublicKey;
}): TransactionInstruction {
  const [baseVault] = getVaultPda(args.market, args.baseMint);
  const [quoteVault] = getVaultPda(args.market, args.quoteMint);
  return new TransactionInstruction({
    programId: PHOENIX_PROGRAM_ID,
    keys: [
      { pubkey: PHOENIX_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: PHOENIX_LOG_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: args.market, isSigner: false, isWritable: true },
      { pubkey: args.marketCreator, isSigner: true, isWritable: true },
      { pubkey: args.baseMint, isSigner: false, isWritable: false },
      { pubkey: args.quoteMint, isSigner: false, isWritable: false },
      { pubkey: baseVault, isSigner: false, isWritable: true },
      { pubkey: quoteVault, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      u8(TAG_INITIALIZE_MARKET),
      encodeInitializeParams(args.feeCollector),
    ]),
  });
}

function buildChangeMarketStatusIx(args: {
  authority: PublicKey;
  market: PublicKey;
  /// 1=Active, 2=PostOnly, 3=Paused, 4=Closed, 5=Tombstoned
  status: number;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: PHOENIX_PROGRAM_ID,
    keys: [
      { pubkey: PHOENIX_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: PHOENIX_LOG_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: args.market, isSigner: false, isWritable: true },
      { pubkey: args.authority, isSigner: true, isWritable: true },
    ],
    data: Buffer.concat([u8(TAG_CHANGE_MARKET_STATUS), u8(args.status)]),
  });
}

function buildRequestSeatAuthorizedIx(args: {
  authority: PublicKey; // signer
  payer: PublicKey;     // signer + writable
  market: PublicKey;
  trader: PublicKey;
}): TransactionInstruction {
  const [seat] = getSeatPda(args.market, args.trader);
  return new TransactionInstruction({
    programId: PHOENIX_PROGRAM_ID,
    keys: [
      { pubkey: PHOENIX_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: PHOENIX_LOG_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: args.market, isSigner: false, isWritable: true },
      { pubkey: args.authority, isSigner: true, isWritable: false },
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: args.trader, isSigner: false, isWritable: false },
      { pubkey: seat, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: u8(TAG_REQUEST_SEAT_AUTHORIZED),
  });
}

function buildChangeSeatStatusIx(args: {
  authority: PublicKey;
  market: PublicKey;
  trader: PublicKey;
  /// 0=NotApproved, 1=Approved, 2=Retired
  status: number;
}): TransactionInstruction {
  const [seat] = getSeatPda(args.market, args.trader);
  return new TransactionInstruction({
    programId: PHOENIX_PROGRAM_ID,
    keys: [
      { pubkey: PHOENIX_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: PHOENIX_LOG_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: args.market, isSigner: false, isWritable: true },
      { pubkey: args.authority, isSigner: true, isWritable: false },
      { pubkey: seat, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([u8(TAG_CHANGE_SEAT_STATUS), u8(args.status)]),
  });
}

function buildPlaceLimitOrderIx(args: {
  market: PublicKey;
  trader: PublicKey;        // signer
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseAccount: PublicKey;   // trader's WSOL ATA
  quoteAccount: PublicKey;  // trader's USDC ATA
  side: number;
  priceInTicks: bigint;
  numBaseLots: bigint;
}): TransactionInstruction {
  const [baseVault] = getVaultPda(args.market, args.baseMint);
  const [quoteVault] = getVaultPda(args.market, args.quoteMint);
  const [seat] = getSeatPda(args.market, args.trader);
  return new TransactionInstruction({
    programId: PHOENIX_PROGRAM_ID,
    keys: [
      { pubkey: PHOENIX_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: PHOENIX_LOG_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: args.market, isSigner: false, isWritable: true },
      { pubkey: args.trader, isSigner: true, isWritable: false },
      { pubkey: seat, isSigner: false, isWritable: false },
      { pubkey: args.baseAccount, isSigner: false, isWritable: true },
      { pubkey: args.quoteAccount, isSigner: false, isWritable: true },
      { pubkey: baseVault, isSigner: false, isWritable: true },
      { pubkey: quoteVault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      u8(TAG_PLACE_LIMIT_ORDER),
      encodePostOnly({
        side: args.side,
        priceInTicks: args.priceInTicks,
        numBaseLots: args.numBaseLots,
      }),
    ]),
  });
}

// ─────────────────────────────────────────────────────────────────────
// Bootstrap entry point
// ─────────────────────────────────────────────────────────────────────

async function loadMarketKeypair(): Promise<Keypair | null> {
  const p = path.resolve(__dirname, 'keys', 'phoenix-market.priv.json');
  if (!fs.existsSync(p)) return null;
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function saveMarketKeypair(kp: Keypair): void {
  const p = path.resolve(__dirname, 'keys', 'phoenix-market.priv.json');
  fs.writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)));
  fs.chmodSync(p, 0o600);
  console.log(`  saved market keypair → ${p}`);
}

async function sendAndConfirm(
  conn: Connection,
  ixs: TransactionInstruction[],
  signers: Keypair[],
  label: string,
): Promise<string> {
  const tx = new Transaction();
  // Always prepend a CU bump so we don't bump into the default 200k.
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }));
  for (const ix of ixs) tx.add(ix);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash(
    'confirmed',
  );
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);

  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  console.log(`  [${label}] sig: ${sig}`);
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  console.log(`  [${label}] confirmed`);
  return sig;
}

async function main() {
  const conn = new Connection(RPC_URL, 'confirmed');

  // Treasury
  const treasuryKey = JSON.parse(fs.readFileSync(TREASURY_KEYPAIR_PATH, 'utf8'));
  const treasury = Keypair.fromSecretKey(Uint8Array.from(treasuryKey));
  console.log(`treasury: ${treasury.publicKey.toBase58()}`);

  const balLamports = await conn.getBalance(treasury.publicKey);
  console.log(`treasury balance: ${balLamports / LAMPORTS_PER_SOL} SOL`);

  const treasuryWsolAta = getAssociatedTokenAddressSync(
    BASE_MINT,
    treasury.publicKey,
  );
  const treasuryUsdcAta = getAssociatedTokenAddressSync(
    QUOTE_MINT,
    treasury.publicKey,
  );
  console.log(`  treasury WSOL ATA: ${treasuryWsolAta.toBase58()}`);
  console.log(`  treasury USDC ATA: ${treasuryUsdcAta.toBase58()}`);

  // Market keypair (load if exists, otherwise generate fresh).
  let market = await loadMarketKeypair();
  if (market) {
    console.log(`market keypair already on disk: ${market.publicKey.toBase58()}`);
  } else {
    market = Keypair.generate();
    console.log(`generated fresh market keypair: ${market.publicKey.toBase58()}`);
    saveMarketKeypair(market);
  }

  // Check whether the market is already initialized.
  const existing = await conn.getAccountInfo(market.publicKey, 'confirmed');
  const alreadyInitialized = existing && existing.owner.equals(PHOENIX_PROGRAM_ID);

  const [baseVaultPda] = getVaultPda(market.publicKey, BASE_MINT);
  const [quoteVaultPda] = getVaultPda(market.publicKey, QUOTE_MINT);

  console.log(`market:        ${market.publicKey.toBase58()}`);
  console.log(`  base_vault:  ${baseVaultPda.toBase58()}`);
  console.log(`  quote_vault: ${quoteVaultPda.toBase58()}`);
  console.log(`  authority:   ${treasury.publicKey.toBase58()}`);
  console.log(`  log_auth:    ${PHOENIX_LOG_AUTHORITY.toBase58()}`);

  const sigs: Record<string, string> = {};

  if (!alreadyInitialized) {
    // Tx1: create_account + InitializeMarket + ChangeMarketStatus(Active).
    console.log('\nTx1 — create_account + InitializeMarket + ChangeMarketStatus(Active)…');
    const rentLamports = await conn.getMinimumBalanceForRentExemption(MARKET_SPACE);
    const createIx = SystemProgram.createAccount({
      fromPubkey: treasury.publicKey,
      newAccountPubkey: market.publicKey,
      lamports: rentLamports,
      space: MARKET_SPACE,
      programId: PHOENIX_PROGRAM_ID,
    });
    const initIx = buildInitializeMarketIx({
      market: market.publicKey,
      marketCreator: treasury.publicKey,
      baseMint: BASE_MINT,
      quoteMint: QUOTE_MINT,
      feeCollector: treasury.publicKey,
    });
    const activateIx = buildChangeMarketStatusIx({
      authority: treasury.publicKey,
      market: market.publicKey,
      status: 1, // Active
    });
    sigs.tx1_init = await sendAndConfirm(
      conn,
      [createIx, initIx, activateIx],
      [treasury, market],
      'tx1',
    );
  } else {
    console.log('\nMarket already initialized — skipping init tx.');
  }

  // Make sure treasury's USDC + WSOL ATAs exist (idempotent).
  console.log('\nTx2 — ensure treasury ATAs (idempotent)…');
  const ataTxIxs: TransactionInstruction[] = [];
  // WSOL ATA
  ataTxIxs.push(
    createAssociatedTokenAccountIdempotentInstruction(
      treasury.publicKey, // payer
      treasuryWsolAta,
      treasury.publicKey, // owner
      BASE_MINT,
    ),
  );
  // USDC ATA already exists (we verified earlier) but make idempotent anyway.
  ataTxIxs.push(
    createAssociatedTokenAccountIdempotentInstruction(
      treasury.publicKey,
      treasuryUsdcAta,
      treasury.publicKey,
      QUOTE_MINT,
    ),
  );
  // Wrap 0.06 SOL → WSOL (need 0.05 for ask + a little slack).
  const wrapAmount = BigInt(0.06 * LAMPORTS_PER_SOL);
  ataTxIxs.push(
    SystemProgram.transfer({
      fromPubkey: treasury.publicKey,
      toPubkey: treasuryWsolAta,
      lamports: wrapAmount,
    }),
  );
  ataTxIxs.push(createSyncNativeInstruction(treasuryWsolAta));
  sigs.tx2_atas_and_wrap = await sendAndConfirm(
    conn,
    ataTxIxs,
    [treasury],
    'tx2',
  );

  // Tx3: RequestSeatAuthorized + ChangeSeatStatus(Approved). Both need
  // treasury as authority.
  console.log('\nTx3 — RequestSeatAuthorized + ChangeSeatStatus(Approved)…');
  const [seatPda] = getSeatPda(market.publicKey, treasury.publicKey);
  const seatInfo = await conn.getAccountInfo(seatPda, 'confirmed');
  if (!seatInfo) {
    sigs.tx3_seat = await sendAndConfirm(
      conn,
      [
        buildRequestSeatAuthorizedIx({
          authority: treasury.publicKey,
          payer: treasury.publicKey,
          market: market.publicKey,
          trader: treasury.publicKey,
        }),
        buildChangeSeatStatusIx({
          authority: treasury.publicKey,
          market: market.publicKey,
          trader: treasury.publicKey,
          status: 1, // Approved
        }),
      ],
      [treasury],
      'tx3',
    );
  } else {
    console.log('  seat already exists, skipping.');
  }

  // Compute resting-order params.
  // num_base_lots_per_base_unit = 1000 (base unit = 1 SOL, lot = 0.001 SOL)
  // tick_size = 1000 quote_lots/base_unit. quote_lot = $0.0001.
  //   => tick_value_in_quote = 1000 * 0.0001 = $0.10 / SOL
  // Therefore: 1 tick = $0.10/SOL price increment.
  // Ask @ $110/SOL = 110 / 0.10 = 1100 ticks.
  // Bid @ $90/SOL  =  90 / 0.10 =  900 ticks.
  // num_base_lots = 50 means 50 * 0.001 SOL = 0.05 SOL on each side.
  // For the bid that costs 0.05 SOL * $90 = $4.50 of USDC, well within 13.5
  // USDC the treasury has.
  const ASK_PRICE_TICKS = 1100n;
  const BID_PRICE_TICKS = 900n;
  const NUM_BASE_LOTS_PER_ORDER = 50n;

  // Tx4: PlaceLimitOrder ASK (sell 0.05 WSOL @ 1100 ticks).
  console.log('\nTx4 — PlaceLimitOrder ASK (0.05 WSOL @ 1100 ticks)…');
  sigs.tx4_ask = await sendAndConfirm(
    conn,
    [
      buildPlaceLimitOrderIx({
        market: market.publicKey,
        trader: treasury.publicKey,
        baseMint: BASE_MINT,
        quoteMint: QUOTE_MINT,
        baseAccount: treasuryWsolAta,
        quoteAccount: treasuryUsdcAta,
        side: SIDE_ASK,
        priceInTicks: ASK_PRICE_TICKS,
        numBaseLots: NUM_BASE_LOTS_PER_ORDER,
      }),
    ],
    [treasury],
    'tx4',
  );

  // Tx5: PlaceLimitOrder BID (buy 0.05 WSOL @ 900 ticks = $4.50 USDC).
  console.log('\nTx5 — PlaceLimitOrder BID (0.05 WSOL @ 900 ticks)…');
  sigs.tx5_bid = await sendAndConfirm(
    conn,
    [
      buildPlaceLimitOrderIx({
        market: market.publicKey,
        trader: treasury.publicKey,
        baseMint: BASE_MINT,
        quoteMint: QUOTE_MINT,
        baseAccount: treasuryWsolAta,
        quoteAccount: treasuryUsdcAta,
        side: SIDE_BID,
        priceInTicks: BID_PRICE_TICKS,
        numBaseLots: NUM_BASE_LOTS_PER_ORDER,
      }),
    ],
    [treasury],
    'tx5',
  );

  // Verify the market header decodes cleanly + the book has resting orders.
  console.log('\nVerification — fetching market account…');
  const finalInfo = await conn.getAccountInfo(market.publicKey, 'confirmed');
  if (!finalInfo) throw new Error('market account vanished');
  console.log(`  market space:  ${finalInfo.data.length}`);
  console.log(`  market owner:  ${finalInfo.owner.toBase58()}`);

  // MarketHeader layout (576 bytes; verified by const_assert_eq! in Phoenix):
  //   8  discriminant
  //   8  status
  //   24 market_size_params
  //   ... etc.
  const disc = finalInfo.data.readBigUInt64LE(0);
  const status = finalInfo.data.readBigUInt64LE(8);
  console.log(`  disc:          ${disc.toString(16)} (expected 715820b77371df77)`);
  console.log(`  status:        ${status} (expected 1 = Active)`);

  console.log('\n────────────────────────────');
  console.log('Bootstrap complete!');
  console.log('────────────────────────────');
  console.log(`market:       ${market.publicKey.toBase58()}`);
  console.log(`base_vault:   ${baseVaultPda.toBase58()}`);
  console.log(`quote_vault:  ${quoteVaultPda.toBase58()}`);
  console.log(`authority:    ${treasury.publicKey.toBase58()}`);
  console.log(`log_authority: ${PHOENIX_LOG_AUTHORITY.toBase58()}`);
  console.log(`seat:         ${seatPda.toBase58()}`);
  console.log('\nSigs:');
  for (const [k, v] of Object.entries(sigs)) {
    console.log(`  ${k}: ${v}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
