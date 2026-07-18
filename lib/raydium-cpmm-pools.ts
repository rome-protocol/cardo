// Raydium CPMM PoolState decoder + RPC helpers + curated pool registry.
//
// PoolState layout (offsets in raw account data buffer; 0..8 is the
// 8-byte Anchor discriminator):
//
//   0..8     discriminator                    [247,237,227,245,215,195,222,70]
//   8..40    amm_config:                      pubkey
//   40..72   pool_creator:                    pubkey
//   72..104  token_0_vault:                   pubkey
//   104..136 token_1_vault:                   pubkey
//   136..168 lp_mint:                         pubkey
//   168..200 token_0_mint:                    pubkey
//   200..232 token_1_mint:                    pubkey
//   232..264 token_0_program:                 pubkey
//   264..296 token_1_program:                 pubkey
//   296..328 observation_key:                 pubkey
//   328      auth_bump:                       u8
//   329      status:                          u8   (bit flags: 1=swap, 2=deposit, 4=withdraw disabled)
//   330      lp_mint_decimals:                u8
//   331      mint_0_decimals:                 u8
//   332      mint_1_decimals:                 u8
//   333..341 lp_supply:                       u64 LE
//   …        fees + open_time + padding (not needed for swap)
//
// Live devnet pool reports 637 bytes total.

import type { Hex } from 'viem';
import { POOL_DISC, POOL_SIZE } from './raydium-cpmm-program';
import { pubkeyBs58ToBytes32 } from './solana-pda';

export type RaydiumCpmmPool = {
  /// Pool account pubkey (caller-supplied; not in the data buffer).
  pubkey?: Hex;
  ammConfig: Hex;
  poolCreator: Hex;
  token0Vault: Hex;
  token1Vault: Hex;
  lpMint: Hex;
  token0Mint: Hex;
  token1Mint: Hex;
  token0Program: Hex;
  token1Program: Hex;
  observationKey: Hex;
  authBump: number;
  /// Status bit flags: 1=swap disabled, 2=deposit disabled, 4=withdraw disabled.
  /// `0` = fully open. Non-zero values gate swap submit.
  status: number;
  lpMintDecimals: number;
  mint0Decimals: number;
  mint1Decimals: number;
  lpSupply: bigint;
  /// Accumulated protocol fees on each side (sit in the vault but are
  /// NOT swappable until the admin claims them). Subtract from raw
  /// vault balance to get effective swap reserves.
  protocolFeesToken0: bigint;
  protocolFeesToken1: bigint;
  fundFeesToken0: bigint;
  fundFeesToken1: bigint;
};

function checkDisc(buf: Buffer): void {
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== POOL_DISC[i]) {
      throw new Error(
        `raydium-cpmm: pool discriminator mismatch (expected ${POOL_DISC.join(',')}, got ${[
          ...buf.subarray(0, 8),
        ].join(',')})`,
      );
    }
  }
}

function readPubkeyHex(buf: Buffer, off: number): Hex {
  return ('0x' + buf.subarray(off, off + 32).toString('hex')) as Hex;
}

/// Decode a PoolState account's `data` field (raw bytes, including the
/// 8-byte Anchor discriminator).
export function decodeRaydiumCpmmPool(
  data: Buffer,
  pubkey?: Hex,
): RaydiumCpmmPool {
  if (data.length < POOL_SIZE) {
    throw new Error(
      `raydium-cpmm: pool data too short (got ${data.length}, expected >= ${POOL_SIZE})`,
    );
  }
  checkDisc(data);
  return {
    pubkey,
    ammConfig: readPubkeyHex(data, 8),
    poolCreator: readPubkeyHex(data, 40),
    token0Vault: readPubkeyHex(data, 72),
    token1Vault: readPubkeyHex(data, 104),
    lpMint: readPubkeyHex(data, 136),
    token0Mint: readPubkeyHex(data, 168),
    token1Mint: readPubkeyHex(data, 200),
    token0Program: readPubkeyHex(data, 232),
    token1Program: readPubkeyHex(data, 264),
    observationKey: readPubkeyHex(data, 296),
    authBump: data[328],
    status: data[329],
    lpMintDecimals: data[330],
    mint0Decimals: data[331],
    mint1Decimals: data[332],
    lpSupply: data.readBigUInt64LE(333),
    protocolFeesToken0: data.readBigUInt64LE(341),
    protocolFeesToken1: data.readBigUInt64LE(349),
    fundFeesToken0: data.readBigUInt64LE(357),
    fundFeesToken1: data.readBigUInt64LE(365),
  };
}

/// Fetch a PoolState from the given Solana RPC endpoint. `rpcUrl` is the
/// cardo proxy route (e.g. '/api/rpc/solana-devnet') because the browser
/// can't talk to api.devnet.solana.com directly.
export async function fetchRaydiumCpmmPool(
  rpcUrl: string,
  poolBs58: string,
): Promise<RaydiumCpmmPool> {
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
    throw new Error(`raydium-cpmm: pool ${poolBs58} not found on this RPC`);
  }
  const buf = Buffer.from(value.data[0], 'base64');
  return decodeRaydiumCpmmPool(buf, pubkeyBs58ToBytes32(poolBs58));
}

// ─────────────────────────────────────────────────────────────────────
// Curated registry — pools Cardo's `/swap-raydium` UI ships with.
//
// Devnet pool: USDC (devnet)/WSOL — sole maintained CPMM pool with
// these exact mints on devnet. Liquidity is thin (~$0.05 at survey
// time); the UI must clamp swap amounts conservatively.
//
// All pubkeys verified live via getAccountInfo against
// api.devnet.solana.com on 2026-04-25.
// ─────────────────────────────────────────────────────────────────────

export type RaydiumCpmmPoolEntry = {
  /// Display label (e.g. "USDC ↔ WSOL · devnet").
  label: string;
  /// Pool account bs58.
  poolBs58: string;
  /// Pool account hex (bytes32).
  poolHex: Hex;
  /// AmmConfig hex.
  ammConfig: Hex;
  /// token_0 mint hex (typically the larger / "base" mint — WSOL here).
  token0Mint: Hex;
  /// token_1 mint hex (typically the quote — USDC here).
  token1Mint: Hex;
  token0Vault: Hex;
  token1Vault: Hex;
  /// SPL Token program for each side (classic vs Token-2022). Both are
  /// classic SPL Token for the WSOL/USDC pool.
  token0Program: Hex;
  token1Program: Hex;
  /// Decimals for each side.
  mint0Decimals: number;
  mint1Decimals: number;
  /// Per-program observation_state account (writable).
  observationKey: Hex;
  /// LP mint pubkey. Required for deposit/withdraw flows; verified live
  /// on devnet for the seeded pool.
  lpMint: Hex;
  /// Network the pool lives on. Sprint 1 only ships `'devnet'`.
  network: 'devnet' | 'mainnet';
  enabled: boolean;
};

const SPL_TOKEN_PROGRAM_HEX: Hex = pubkeyBs58ToBytes32(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
);

const USDC_WSOL_DEVNET: RaydiumCpmmPoolEntry = {
  label: 'USDC ↔ WSOL · devnet',
  poolBs58: '2HyNe5a32uVoB4BybXCLak41QrejZLqF9hZM6KBMQ1V2',
  poolHex: pubkeyBs58ToBytes32('2HyNe5a32uVoB4BybXCLak41QrejZLqF9hZM6KBMQ1V2'),
  ammConfig: pubkeyBs58ToBytes32(
    '9zSzfkYy6awexsHvmggeH36pfVUdDGyCcwmjT3AQPBj6',
  ),
  // token_0 = WSOL
  token0Mint: pubkeyBs58ToBytes32(
    'So11111111111111111111111111111111111111112',
  ),
  // token_1 = USDC devnet (same mint Cardo bridges through for WUSDC)
  token1Mint: pubkeyBs58ToBytes32(
    '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  ),
  token0Vault: pubkeyBs58ToBytes32(
    '3A8Y82QVHqC7tHQ5VEnbuGC2niaRgqMWjGFU2zPr6kEk',
  ),
  token1Vault: pubkeyBs58ToBytes32(
    '7sDCGy7HRXqJvFLw4QRMNXEr3c7NX6emAkL4yyBfeQWC',
  ),
  token0Program: SPL_TOKEN_PROGRAM_HEX,
  token1Program: SPL_TOKEN_PROGRAM_HEX,
  mint0Decimals: 9, // WSOL
  mint1Decimals: 6, // USDC
  observationKey: pubkeyBs58ToBytes32(
    '5G9B7Dva91ornqJGcfJuz8a3AcDKiEFKnXRdKN8TwZgb',
  ),
  // LP mint — verified live via getProgramAccounts for the seeded
  // pool (offset 136 in PoolState data buffer).
  lpMint: pubkeyBs58ToBytes32(
    'J7s5DNG1PwSXhE9tgw1SZCehWhRoCfyAeE2XscSA9UTC',
  ),
  network: 'devnet',
  enabled: true,
} as const;

export const RAYDIUM_CPMM_POOL_REGISTRY: ReadonlyArray<RaydiumCpmmPoolEntry> = [
  USDC_WSOL_DEVNET,
];

export const ENABLED_RAYDIUM_CPMM_POOLS: ReadonlyArray<RaydiumCpmmPoolEntry> =
  RAYDIUM_CPMM_POOL_REGISTRY.filter((p) => p.enabled);

// ─────────────────────────────────────────────────────────────────────
// Constant-product (x*y=k) quote with Raydium CPMM's fee schedule.
//
// Trade fee tier comes from AmmConfig.trade_fee_rate (ppm denominator
// 1_000_000). Live devnet AmmConfig 9zSzfk… reports 2500 → 25 bps.
// We pass it explicitly so the same helper handles other pools later.
// ─────────────────────────────────────────────────────────────────────

const FEE_DENOM = 1_000_000n;

/// Quote an exact-input swap. `feeRatePpm` is the AmmConfig.trade_fee_rate
/// (e.g. 2500 for 25 bps). Output is indicative; UI must enforce a
/// `minimum_amount_out` slippage guard at submit.
export function quoteRaydiumCpmmSwapBaseInput(
  inputReserve: bigint,
  outputReserve: bigint,
  amountIn: bigint,
  feeRatePpm: bigint,
): bigint {
  if (amountIn <= 0n) return 0n;
  if (inputReserve <= 0n || outputReserve <= 0n) return 0n;
  const amountInAfterFee = (amountIn * (FEE_DENOM - feeRatePpm)) / FEE_DENOM;
  const num = amountInAfterFee * outputReserve;
  const den = inputReserve + amountInAfterFee;
  return num / den;
}
