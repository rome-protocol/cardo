// lib/jupiter-perps.ts — builders for Jupiter Perps (mainnet)
// request-fulfillment flow: the user signs ONE tx creating a PositionRequest;
// Jupiter keepers execute it against the JLP pool at oracle price.
//
// Ground truth: the ON-CHAIN anchor IDL (fetched 2026-07-07, saved in the
// session scratchpad) + live accounts pinned in tests/fixtures/jup-perps-live.json:
//   Position PDA        = ["position", owner, pool, custody, collateralCustody, side_u8]
//   PositionRequest PDA = ["position_request", position, counter_u64_le, requestChange_u8]
// (both schemas brute-verified against 3+2 live mainnet accounts).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
  JUP_PERPS_PROGRAM,
  JLP_POOL,
  JUP_PERPS_CUSTODIES,
  Side,
  derivePosition,
  derivePositionRequest,
  buildIncreasePositionMarketRequestIx,
  buildDecreasePositionMarketRequestIx,
} from '../lib/jupiter-perps';

const FIX = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'jup-perps-live.json'), 'utf8'),
) as {
  positions: Array<{
    pubkey: string; owner: string; pool: string; custody: string;
    collateralCustody: string; side: number;
  }>;
  requests: Array<{
    pubkey: string; position: string; requestChange: number; counter: string;
  }>;
};

const disc = (name: string) =>
  createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);

describe('jupiter-perps constants', () => {
  it('pins the on-chain-discovered program + pool', () => {
    expect(JUP_PERPS_PROGRAM.toBase58()).toBe('PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu');
    expect(JLP_POOL.toBase58()).toBe('5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq');
    expect(JUP_PERPS_CUSTODIES.SOL.custody.toBase58()).toBe('7xS2gz2bTp3fwCC7knJvUWTEU9Tycczu6VhJYKgi1wdz');
    expect(JUP_PERPS_CUSTODIES.USDC.custody.toBase58()).toBe('G18jKKXQwBbrHeiK3C9MRXhkHsLHf7XgCSisykV46EZa');
  });
});

describe('derivePosition', () => {
  it('reproduces every live fixture position PDA', () => {
    for (const p of FIX.positions) {
      const derived = derivePosition({
        owner: new PublicKey(p.owner),
        custody: new PublicKey(p.custody),
        collateralCustody: new PublicKey(p.collateralCustody),
        side: p.side as Side,
      });
      expect(derived.toBase58()).toBe(p.pubkey);
    }
  });
});

describe('derivePositionRequest', () => {
  it('reproduces every live fixture request PDA', () => {
    for (const r of FIX.requests) {
      const derived = derivePositionRequest({
        position: new PublicKey(r.position),
        counter: BigInt(r.counter),
        requestChange: r.requestChange as 1 | 2,
      });
      expect(derived.toBase58()).toBe(r.pubkey);
    }
  });
});

describe('buildIncreasePositionMarketRequestIx', () => {
  const owner = new PublicKey('JsdXEHXZ9uzfpbV7ppvFh2w2PAx9niYgrmbgMRrbmg7');
  const ix = buildIncreasePositionMarketRequestIx({
    owner,
    market: 'SOL',
    side: Side.Short, // shorts collateralize in USDC — all-stable v1 flow
    sizeUsdDelta: 12_000_000n, // $12 (6dp USD units)
    collateralTokenDelta: 4_000_000n, // 4 USDC
    priceSlippage: 150_000_000n, // $150 floor for a short entry
    counter: 42n,
  });

  it('targets the perps program with the IDL account count', () => {
    expect(ix.programId.equals(JUP_PERPS_PROGRAM)).toBe(true);
    expect(ix.keys.length).toBe(16);
  });

  it('puts owner first as writable signer; funding ATA second', () => {
    expect(ix.keys[0].pubkey.equals(owner)).toBe(true);
    expect(ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[0].isWritable).toBe(true);
    expect(ix.keys[1].isWritable).toBe(true);
  });

  it('wires position + positionRequest at IDL slots 4/5 from the derivations', () => {
    const position = derivePosition({
      owner,
      custody: JUP_PERPS_CUSTODIES.SOL.custody,
      collateralCustody: JUP_PERPS_CUSTODIES.USDC.custody,
      side: Side.Short,
    });
    const request = derivePositionRequest({ position, counter: 42n, requestChange: 1 });
    expect(ix.keys[4].pubkey.equals(position)).toBe(true);
    expect(ix.keys[5].pubkey.equals(request)).toBe(true);
    // short: custody = traded market, collateralCustody = USDC
    expect(ix.keys[7].pubkey.equals(JUP_PERPS_CUSTODIES.SOL.custody)).toBe(true);
    expect(ix.keys[8].pubkey.equals(JUP_PERPS_CUSTODIES.USDC.custody)).toBe(true);
  });

  it('encodes the exact borsh params after the discriminator', () => {
    expect(Buffer.from(ix.data.subarray(0, 8))).toEqual(disc('create_increase_position_market_request'));
    const body = Buffer.from(ix.data.subarray(8));
    let o = 0;
    expect(body.readBigUInt64LE(o)).toBe(12_000_000n); o += 8; // sizeUsdDelta
    expect(body.readBigUInt64LE(o)).toBe(4_000_000n); o += 8; // collateralTokenDelta
    expect(body[o]).toBe(2); o += 1; // Side.Short enum index
    expect(body.readBigUInt64LE(o)).toBe(150_000_000n); o += 8; // priceSlippage
    expect(body[o]).toBe(0); o += 1; // jupiterMinimumOut: None
    expect(body.readBigUInt64LE(o)).toBe(42n); o += 8; // counter
    expect(body.length).toBe(o); // nothing trailing
  });

  it('longs collateralize in the traded custody itself', () => {
    const ixLong = buildIncreasePositionMarketRequestIx({
      owner,
      market: 'SOL',
      side: Side.Long,
      sizeUsdDelta: 12_000_000n,
      collateralTokenDelta: 20_000_000n, // 0.02 SOL (9dp)
      priceSlippage: 250_000_000n,
      counter: 7n,
    });
    expect(ixLong.keys[7].pubkey.equals(JUP_PERPS_CUSTODIES.SOL.custody)).toBe(true);
    expect(ixLong.keys[8].pubkey.equals(JUP_PERPS_CUSTODIES.SOL.custody)).toBe(true);
  });
});

describe('buildDecreasePositionMarketRequestIx', () => {
  const owner = new PublicKey('JsdXEHXZ9uzfpbV7ppvFh2w2PAx9niYgrmbgMRrbmg7');
  const ix = buildDecreasePositionMarketRequestIx({
    owner,
    market: 'SOL',
    side: Side.Short,
    entirePosition: true,
    priceSlippage: 200_000_000n, // $200 cap to close a short
    counter: 43n,
  });

  it('encodes close-entire-position with zero deltas', () => {
    expect(Buffer.from(ix.data.subarray(0, 8))).toEqual(disc('create_decrease_position_market_request'));
    const body = Buffer.from(ix.data.subarray(8));
    let o = 0;
    expect(body.readBigUInt64LE(o)).toBe(0n); o += 8; // collateralUsdDelta
    expect(body.readBigUInt64LE(o)).toBe(0n); o += 8; // sizeUsdDelta
    expect(body.readBigUInt64LE(o)).toBe(200_000_000n); o += 8; // priceSlippage
    expect(body[o]).toBe(0); o += 1; // jupiterMinimumOut None
    expect(body[o]).toBe(1); o += 1; // entirePosition Some
    expect(body[o]).toBe(1); o += 1; // = true
    expect(body.readBigUInt64LE(o)).toBe(43n); o += 8; // counter
    expect(body.length).toBe(o);
  });

  it('marks the request as a Decrease in the PDA derivation', () => {
    const position = derivePosition({
      owner,
      custody: JUP_PERPS_CUSTODIES.SOL.custody,
      collateralCustody: JUP_PERPS_CUSTODIES.USDC.custody,
      side: Side.Short,
    });
    const request = derivePositionRequest({ position, counter: 43n, requestChange: 2 });
    expect(ix.keys[5].pubkey.equals(request)).toBe(true);
  });
});
