// Pump.fun BondingCurve account decoder + RPC helpers.
//
// The BondingCurve account holds the per-memecoin curve state:
// reserves, total supply, the `complete` flag (set to 1 once the
// token graduates to PumpSwap), and the creator pubkey (used to
// derive the `creator_vault` PDA at buy/sell time).

import type { Hex } from 'viem';
import {
  BONDING_CURVE_DISC,
  BONDING_CURVE_FIELD_OFFSETS,
} from './pumpfun-program';

export type BondingCurve = {
  /// Account pubkey (caller-supplied; not in the data buffer).
  pubkey?: Hex;
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  /// `true` iff the curve has graduated to PumpSwap.
  complete: boolean;
  creator: Hex;
};

function checkDisc(buf: Buffer): void {
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== BONDING_CURVE_DISC[i]) {
      throw new Error(
        `pumpfun: bonding curve discriminator mismatch (expected ${BONDING_CURVE_DISC.join(',')}, got ${[
          ...buf.subarray(0, 8),
        ].join(',')})`,
      );
    }
  }
}

export function decodeBondingCurve(data: Buffer, pubkey?: Hex): BondingCurve {
  if (data.length < BONDING_CURVE_FIELD_OFFSETS.creator + 32) {
    throw new Error(
      `pumpfun: bonding curve data too short (got ${data.length})`,
    );
  }
  checkDisc(data);
  return {
    pubkey,
    virtualTokenReserves: data.readBigUInt64LE(
      BONDING_CURVE_FIELD_OFFSETS.virtualTokenReserves,
    ),
    virtualSolReserves: data.readBigUInt64LE(
      BONDING_CURVE_FIELD_OFFSETS.virtualSolReserves,
    ),
    realTokenReserves: data.readBigUInt64LE(
      BONDING_CURVE_FIELD_OFFSETS.realTokenReserves,
    ),
    realSolReserves: data.readBigUInt64LE(
      BONDING_CURVE_FIELD_OFFSETS.realSolReserves,
    ),
    tokenTotalSupply: data.readBigUInt64LE(
      BONDING_CURVE_FIELD_OFFSETS.tokenTotalSupply,
    ),
    complete: data[BONDING_CURVE_FIELD_OFFSETS.complete] === 1,
    creator: ('0x' +
      data
        .subarray(
          BONDING_CURVE_FIELD_OFFSETS.creator,
          BONDING_CURVE_FIELD_OFFSETS.creator + 32,
        )
        .toString('hex')) as Hex,
  };
}

/// Fetch a BondingCurve account from the given RPC and decode it.
/// `rpcUrl` is the cardo proxy route (e.g. '/api/rpc/solana-devnet').
export async function fetchBondingCurve(
  rpcUrl: string,
  curveBs58: string,
): Promise<BondingCurve> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getAccountInfo',
      params: [curveBs58, { encoding: 'base64' }],
    }),
  });
  const json = await res.json();
  const value = json?.result?.value;
  if (!value) {
    throw new Error(`pumpfun: bonding curve ${curveBs58} not found`);
  }
  const buf = Buffer.from(value.data[0], 'base64');
  return decodeBondingCurve(buf);
}

// ─────────────────────────────────────────────────────────────────────
// Constant-product quote with Pump.fun's virtual reserves.
//
// Pump.fun uses a virtual-reserves AMM (the curve starts with virtual
// SOL and virtual tokens that aren't actually in the vault, then real
// reserves accumulate as users buy). The quote uses
// `virtual_sol_reserves` and `virtual_token_reserves` (both grow as
// trades land — virtual_token decreases on buys, virtual_sol
// increases). 1% protocol fee.
// ─────────────────────────────────────────────────────────────────────

const FEE_BPS = 100n; // 1% Pump.fun protocol fee
const BPS_DENOM = 10_000n;

/// Buy quote — user spends `solIn` lamports, receives memecoin tokens.
export function quotePumpFunBuy(
  curve: BondingCurve,
  solIn: bigint,
): bigint {
  if (solIn <= 0n) return 0n;
  const fee = (solIn * FEE_BPS) / BPS_DENOM;
  const inAfterFee = solIn - fee;
  const num = inAfterFee * curve.virtualTokenReserves;
  const den = curve.virtualSolReserves + inAfterFee;
  return num / den;
}

/// Sell quote — user spends `tokenIn` memecoin (atoms), receives SOL.
export function quotePumpFunSell(
  curve: BondingCurve,
  tokenIn: bigint,
): bigint {
  if (tokenIn <= 0n) return 0n;
  const num = tokenIn * curve.virtualSolReserves;
  const den = curve.virtualTokenReserves + tokenIn;
  const solOut = num / den;
  const fee = (solOut * FEE_BPS) / BPS_DENOM;
  return solOut - fee;
}
