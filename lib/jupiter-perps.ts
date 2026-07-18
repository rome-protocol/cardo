// Jupiter Perps (mainnet) — request-fulfillment builders for the /perps surface.
//
// Model: the user signs ONE tx that creates a PositionRequest (collateral is
// escrowed into the request's ATA); Jupiter's keepers execute the request
// against the JLP pool at oracle price within seconds. Opening and closing
// are both requests — `createIncreasePositionMarketRequest` and
// `createDecreasePositionMarketRequest`. This avoids the `instant*` ix family,
// which needs Jupiter's signed-price service.
//
// Ground truth is the ON-CHAIN anchor IDL (v0.1.0, fetched 2026-07-07) plus
// live-account verification — the program id itself was recovered from the
// JLP mint's transactions after the from-memory id proved wrong. PDA schemas
// were brute-verified against live accounts (see tests/jupiter-perps.test.ts):
//   Position        = PDA(["position", owner, pool, custody, collateralCustody, side_u8])
//   PositionRequest = PDA(["position_request", position, counter_u64_le, requestChange_u8])
//
// Collateral convention (from live positions): longs collateralize in the
// traded token's custody; shorts collateralize in a stable custody (USDC).

import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { createHash } from 'node:crypto';

export const JUP_PERPS_PROGRAM = new PublicKey(
  'PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu',
);
export const JLP_POOL = new PublicKey(
  '5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq',
);

/// Anchor CPI-event authority: PDA(["__event_authority"], program).
export const JUP_PERPS_EVENT_AUTHORITY = PublicKey.findProgramAddressSync(
  [Buffer.from('__event_authority')],
  JUP_PERPS_PROGRAM,
)[0];

/// Perpetuals config account: PDA(["perpetuals"], program).
export const JUP_PERPS_PERPETUALS = PublicKey.findProgramAddressSync(
  [Buffer.from('perpetuals')],
  JUP_PERPS_PROGRAM,
)[0];

export enum Side {
  Long = 1,
  Short = 2,
}

export type PerpMarketSymbol = 'SOL' | 'ETH' | 'BTC';

/// Pool custodies (enumerated on-chain from the JLP pool, 2026-07-07).
/// Tradeable custodies carry the market; stable custodies collateralize shorts.
export const JUP_PERPS_CUSTODIES = {
  SOL: {
    custody: new PublicKey('7xS2gz2bTp3fwCC7knJvUWTEU9Tycczu6VhJYKgi1wdz'),
    mint: new PublicKey('So11111111111111111111111111111111111111112'),
    decimals: 9,
  },
  ETH: {
    custody: new PublicKey('5Pv3gM9JrFFH883SWAhvJC9RPYmo8UNxuFtv5bMMALkm'),
    mint: new PublicKey('3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh'),
    decimals: 8,
  },
  BTC: {
    custody: new PublicKey('AQCGyheWPLeo6Qp9WpYS9m3Qj479t7R636N9ey1rEjEn'),
    mint: new PublicKey('7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs'),
    decimals: 8,
  },
  USDC: {
    custody: new PublicKey('G18jKKXQwBbrHeiK3C9MRXhkHsLHf7XgCSisykV46EZa'),
    mint: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
    decimals: 6,
  },
} as const;

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111');

const ixDisc = (name: string) =>
  createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
// Anchor hashes the RUST method name (snake_case) — the IDL shows camelCase
// but sha256("global:createIncrease…") dispatches to InstructionFallbackNotFound
// (verified by mainnet simulation; opposite of the Drift build's convention).
const INCREASE_DISC = ixDisc('create_increase_position_market_request');
const DECREASE_DISC = ixDisc('create_decrease_position_market_request');

function u64le(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v, 0);
  return b;
}

function ata(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    ATOKEN_PROGRAM,
  )[0];
}

/// Shorts collateralize in USDC; longs in the traded custody itself.
export function collateralCustodyFor(market: PerpMarketSymbol, side: Side) {
  return side === Side.Long ? JUP_PERPS_CUSTODIES[market] : JUP_PERPS_CUSTODIES.USDC;
}

export function derivePosition(args: {
  owner: PublicKey;
  custody: PublicKey;
  collateralCustody: PublicKey;
  side: Side;
}): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('position'),
      args.owner.toBuffer(),
      JLP_POOL.toBuffer(),
      args.custody.toBuffer(),
      args.collateralCustody.toBuffer(),
      Buffer.from([args.side]),
    ],
    JUP_PERPS_PROGRAM,
  )[0];
}

export function derivePositionRequest(args: {
  position: PublicKey;
  counter: bigint;
  /// 1 = Increase, 2 = Decrease (RequestChange enum, IDL order).
  requestChange: 1 | 2;
}): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('position_request'),
      args.position.toBuffer(),
      u64le(args.counter),
      Buffer.from([args.requestChange]),
    ],
    JUP_PERPS_PROGRAM,
  )[0];
}

/// Referral: the IDL account is non-optional; Jupiter's own txs pass the
/// program id itself as the "none" sentinel for optional anchor accounts.
const NO_REFERRAL = JUP_PERPS_PROGRAM;

export function buildIncreasePositionMarketRequestIx(args: {
  owner: PublicKey;
  market: PerpMarketSymbol;
  side: Side;
  /// Position size delta in USD, 6dp (e.g. $12 → 12_000_000n).
  sizeUsdDelta: bigint;
  /// Collateral amount in the INPUT mint's native units.
  collateralTokenDelta: bigint;
  /// Worst acceptable entry price, USD 6dp (max for longs, min for shorts).
  priceSlippage: bigint;
  /// Unique per request; part of the PositionRequest PDA.
  counter: bigint;
  /// Input mint funding the collateral. Defaults to the collateral custody's
  /// mint (no in-flow swap → jupiterMinimumOut stays None).
  inputMint?: PublicKey;
  /// Required iff inputMint differs from the collateral custody mint.
  jupiterMinimumOut?: bigint;
}): TransactionInstruction {
  const custody = JUP_PERPS_CUSTODIES[args.market];
  const collateral = collateralCustodyFor(args.market, args.side);
  const inputMint = args.inputMint ?? collateral.mint;
  const position = derivePosition({
    owner: args.owner,
    custody: custody.custody,
    collateralCustody: collateral.custody,
    side: args.side,
  });
  const positionRequest = derivePositionRequest({
    position,
    counter: args.counter,
    requestChange: 1,
  });

  const data = Buffer.concat([
    INCREASE_DISC,
    u64le(args.sizeUsdDelta),
    u64le(args.collateralTokenDelta),
    Buffer.from([args.side]),
    u64le(args.priceSlippage),
    args.jupiterMinimumOut !== undefined
      ? Buffer.concat([Buffer.from([1]), u64le(args.jupiterMinimumOut)])
      : Buffer.from([0]),
    u64le(args.counter),
  ]);

  return new TransactionInstruction({
    programId: JUP_PERPS_PROGRAM,
    keys: [
      { pubkey: args.owner, isSigner: true, isWritable: true },
      { pubkey: ata(args.owner, inputMint), isSigner: false, isWritable: true }, // fundingAccount
      { pubkey: JUP_PERPS_PERPETUALS, isSigner: false, isWritable: false },
      { pubkey: JLP_POOL, isSigner: false, isWritable: false },
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: positionRequest, isSigner: false, isWritable: true },
      { pubkey: ata(positionRequest, inputMint), isSigner: false, isWritable: true },
      { pubkey: custody.custody, isSigner: false, isWritable: false },
      { pubkey: collateral.custody, isSigner: false, isWritable: false },
      { pubkey: inputMint, isSigner: false, isWritable: false },
      { pubkey: NO_REFERRAL, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: ATOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: JUP_PERPS_EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: JUP_PERPS_PROGRAM, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function buildDecreasePositionMarketRequestIx(args: {
  owner: PublicKey;
  market: PerpMarketSymbol;
  side: Side;
  /// Close everything (sizeUsdDelta/collateralUsdDelta 0 + entirePosition).
  entirePosition?: boolean;
  /// USD 6dp partial deltas (ignored when entirePosition).
  sizeUsdDelta?: bigint;
  collateralUsdDelta?: bigint;
  /// Worst acceptable execution price, USD 6dp (min for longs, max for shorts).
  priceSlippage: bigint;
  counter: bigint;
  /// Mint the proceeds should arrive in. Defaults to the collateral mint.
  desiredMint?: PublicKey;
  jupiterMinimumOut?: bigint;
}): TransactionInstruction {
  const custody = JUP_PERPS_CUSTODIES[args.market];
  const collateral = collateralCustodyFor(args.market, args.side);
  const desiredMint = args.desiredMint ?? collateral.mint;
  const position = derivePosition({
    owner: args.owner,
    custody: custody.custody,
    collateralCustody: collateral.custody,
    side: args.side,
  });
  const positionRequest = derivePositionRequest({
    position,
    counter: args.counter,
    requestChange: 2,
  });

  const data = Buffer.concat([
    DECREASE_DISC,
    u64le(args.collateralUsdDelta ?? 0n),
    u64le(args.sizeUsdDelta ?? 0n),
    u64le(args.priceSlippage),
    args.jupiterMinimumOut !== undefined
      ? Buffer.concat([Buffer.from([1]), u64le(args.jupiterMinimumOut)])
      : Buffer.from([0]),
    args.entirePosition !== undefined
      ? Buffer.from([1, args.entirePosition ? 1 : 0])
      : Buffer.from([0]),
    u64le(args.counter),
  ]);

  return new TransactionInstruction({
    programId: JUP_PERPS_PROGRAM,
    keys: [
      { pubkey: args.owner, isSigner: true, isWritable: true },
      { pubkey: ata(args.owner, desiredMint), isSigner: false, isWritable: true }, // receivingAccount
      { pubkey: JUP_PERPS_PERPETUALS, isSigner: false, isWritable: false },
      { pubkey: JLP_POOL, isSigner: false, isWritable: false },
      { pubkey: position, isSigner: false, isWritable: false },
      { pubkey: positionRequest, isSigner: false, isWritable: true },
      { pubkey: ata(positionRequest, desiredMint), isSigner: false, isWritable: true },
      { pubkey: custody.custody, isSigner: false, isWritable: false },
      { pubkey: collateral.custody, isSigner: false, isWritable: false },
      { pubkey: desiredMint, isSigner: false, isWritable: false },
      { pubkey: NO_REFERRAL, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: ATOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: JUP_PERPS_EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: JUP_PERPS_PROGRAM, isSigner: false, isWritable: false },
    ],
    data,
  });
}
