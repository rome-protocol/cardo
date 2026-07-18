// PumpSwap Pool account decoder + RPC helpers.
//
// Pool struct layout (verified against the on-chain IDL + a sample
// devnet account):
//   0..8    discriminator                      [241,154,109,4,17,177,109,188]
//   8       pool_bump:               u8
//   9..11   index:                   u16 LE
//   11..43  creator:                 pubkey
//   43..75  base_mint:               pubkey
//   75..107 quote_mint:              pubkey
//   107..139 lp_mint:                pubkey
//   139..171 pool_base_token_account:  pubkey  ← base vault
//   171..203 pool_quote_token_account: pubkey  ← quote vault
//   203..211 lp_supply:              u64 LE
//   211..243 coin_creator:           pubkey
//   243     is_mayhem_mode:          u8
//   244     is_cashback_coin:        u8
//
// Total: 245 bytes.

import type { Hex } from 'viem';
import { POOL_DISC, POOL_SIZE } from './pumpswap-program';

export type PumpSwapPool = {
  /// Pool account pubkey (caller-supplied; not in the data buffer).
  pubkey?: Hex;
  poolBump: number;
  index: number;
  creator: Hex;
  baseMint: Hex;
  quoteMint: Hex;
  lpMint: Hex;
  poolBaseTokenAccount: Hex;
  poolQuoteTokenAccount: Hex;
  lpSupply: bigint;
  coinCreator: Hex;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
};

function checkDisc(buf: Buffer): void {
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== POOL_DISC[i]) {
      throw new Error(
        `pumpswap: pool discriminator mismatch (expected ${POOL_DISC.join(',')}, got ${[
          ...buf.subarray(0, 8),
        ].join(',')})`,
      );
    }
  }
}

function readPubkeyHex(buf: Buffer, off: number): Hex {
  return ('0x' + buf.subarray(off, off + 32).toString('hex')) as Hex;
}

/// Decode a Pool account's `data` field (raw bytes, including the 8-byte
/// Anchor discriminator).
export function decodePumpSwapPool(data: Buffer, pubkey?: Hex): PumpSwapPool {
  if (data.length < POOL_SIZE) {
    throw new Error(
      `pumpswap: pool data too short (got ${data.length}, expected >= ${POOL_SIZE})`,
    );
  }
  checkDisc(data);
  return {
    pubkey,
    poolBump: data[8],
    index: data.readUInt16LE(9),
    creator: readPubkeyHex(data, 11),
    baseMint: readPubkeyHex(data, 43),
    quoteMint: readPubkeyHex(data, 75),
    lpMint: readPubkeyHex(data, 107),
    poolBaseTokenAccount: readPubkeyHex(data, 139),
    poolQuoteTokenAccount: readPubkeyHex(data, 171),
    lpSupply: data.readBigUInt64LE(203),
    coinCreator: readPubkeyHex(data, 211),
    isMayhemMode: data[243] === 1,
    isCashbackCoin: data[244] === 1,
  };
}

/// Fetch a Pool account from the given Solana RPC endpoint and decode it.
/// `rpcUrl` is the cardo proxy route (e.g. '/api/rpc/solana-devnet'),
/// because the browser can't talk to api.devnet.solana.com directly.
export async function fetchPumpSwapPool(
  rpcUrl: string,
  poolBs58: string,
): Promise<PumpSwapPool> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getAccountInfo',
      params: [poolBs58, { encoding: 'base64' }],
    }),
  });
  const json = await res.json();
  const value = json?.result?.value;
  if (!value) {
    throw new Error(`pumpswap: pool ${poolBs58} not found on this RPC`);
  }
  const buf = Buffer.from(value.data[0], 'base64');
  return decodePumpSwapPool(buf);
}

/// Constant-product (x*y=k) quote with PumpSwap's published fee schedule.
///
/// `lpFeeBps` (20) and `protocolFeeBps` (5) are taken from the GlobalConfig
/// account; we hardcode them for the indicative quote and let the on-chain
/// program enforce the real numbers at execute time.
const LP_FEE_BPS = 20n;
const PROTOCOL_FEE_BPS = 5n;
const TOTAL_FEE_BPS = LP_FEE_BPS + PROTOCOL_FEE_BPS;
const BPS_DENOM = 10_000n;

/// Buy quote — user spends `quoteIn` quote tokens, receives base tokens.
/// Returns the indicative `baseOut`. Caller is responsible for slippage
/// guard (`max_quote_amount_in` arg on the buy ix).
export function quotePumpSwapBuy(
  poolBaseReserve: bigint,
  poolQuoteReserve: bigint,
  quoteIn: bigint,
): bigint {
  if (quoteIn <= 0n) return 0n;
  const feeNum = TOTAL_FEE_BPS;
  const inAfterFee = (quoteIn * (BPS_DENOM - feeNum)) / BPS_DENOM;
  const num = inAfterFee * poolBaseReserve;
  const den = poolQuoteReserve + inAfterFee;
  return num / den;
}

/// Sell quote — user spends `baseIn` base tokens, receives quote tokens.
export function quotePumpSwapSell(
  poolBaseReserve: bigint,
  poolQuoteReserve: bigint,
  baseIn: bigint,
): bigint {
  if (baseIn <= 0n) return 0n;
  const feeNum = TOTAL_FEE_BPS;
  const inAfterFee = (baseIn * (BPS_DENOM - feeNum)) / BPS_DENOM;
  const num = inAfterFee * poolQuoteReserve;
  const den = poolBaseReserve + inAfterFee;
  return num / den;
}
