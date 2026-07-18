// Raydium AMM v4 AmmInfo decoder + RPC helpers + curated pool registry.
//
// AMM v4's AmmInfo struct is `repr(C, packed)`, NOT Anchor — there's no
// 8-byte discriminator. Filter by `dataSize: 752` to enumerate pools.
//
// Layout (verified against pool 8Mwd2xFBRNDGXPiGPx79e1xkWqJaUoQoGhx8vavZcfsQ
// on devnet 2026-04-26 — every field cross-checked against
// https://github.com/raydium-io/raydium-amm/blob/master/program/src/state.rs):
//
//   0..128   16 status u64 fields (status, nonce, order_num, depth,
//            coin_decimals, pc_decimals, state, reset_flag, min_size,
//            vol_max_cut_ratio, amount_wave, coin_lot_size, pc_lot_size,
//            min_price_multiplier, max_price_multiplier, sys_decimal_value)
//   128..192 Fees (8 u64): min_separate num/den, trade_fee num/den,
//                          pnl num/den, swap_fee num/den
//   192..336 StateData (144B): need_take_pnl_coin u64,
//                              need_take_pnl_pc u64,
//                              total_pnl_pc u64,
//                              total_pnl_coin u64,
//                              pool_open_time u64,
//                              padding [u64; 2],
//                              orderbook_to_init_time u64,
//                              swap_coin_in_amount u128,
//                              swap_pc_out_amount u128,
//                              swap_acc_pc_fee u64,
//                              swap_pc_in_amount u128,
//                              swap_coin_out_amount u128,
//                              swap_acc_coin_fee u64
//   336..368 coin_vault       Pubkey
//   368..400 pc_vault         Pubkey
//   400..432 coin_vault_mint  Pubkey
//   432..464 pc_vault_mint    Pubkey
//   464..496 lp_mint          Pubkey
//   496..528 open_orders      Pubkey
//   528..560 market           Pubkey
//   560..592 market_program   Pubkey
//   592..624 target_orders    Pubkey
//   624..688 padding1 [u64; 8]
//   688..720 amm_owner        Pubkey
//   720..728 lp_amount        u64
//   728..736 client_order_id  u64
//   736..744 recent_epoch     u64
//   744..752 padding2         u64

import type { Hex } from 'viem';
import {
  AMM_INFO_SIZE,
  AMM_STATUS_SWAP_ONLY,
  AMM_STATUS_INITIALIZED,
  AMM_STATUS_WAITING_TRADE,
} from './raydium-amm-program';
import { pubkeyBs58ToBytes32 } from './solana-pda';

export type RaydiumAmmV4Pool = {
  /// Pool account pubkey (caller-supplied; not in the data buffer).
  pubkey?: Hex;
  status: bigint;
  nonce: bigint;
  coinDecimals: number;
  pcDecimals: number;
  /// Fees: trade_fee_numerator / trade_fee_denominator. AMM v4's pool
  /// applies the trade fee from these on input. Default initialized to
  /// 25 / 10000 (25 bps).
  tradeFeeNumerator: bigint;
  tradeFeeDenominator: bigint;
  /// Fees that have accumulated as protocol PNL (taken on the pc side).
  /// Subtracted from raw vault balance to get effective swap reserves.
  needTakePnlCoin: bigint;
  needTakePnlPc: bigint;
  coinVault: Hex;
  pcVault: Hex;
  coinVaultMint: Hex;
  pcVaultMint: Hex;
  lpMint: Hex;
  openOrders: Hex;
  market: Hex;
  marketProgram: Hex;
  targetOrders: Hex;
  ammOwner: Hex;
};

function readPubkeyHex(buf: Buffer, off: number): Hex {
  return ('0x' + buf.subarray(off, off + 32).toString('hex')) as Hex;
}

/// Decode an AmmInfo account's `data` field (raw 752 bytes).
export function decodeRaydiumAmmV4Pool(
  data: Buffer,
  pubkey?: Hex,
): RaydiumAmmV4Pool {
  if (data.length !== AMM_INFO_SIZE) {
    throw new Error(
      `raydium-amm-v4: AmmInfo size mismatch (got ${data.length}, expected ${AMM_INFO_SIZE})`,
    );
  }
  return {
    pubkey,
    status: data.readBigUInt64LE(0),
    nonce: data.readBigUInt64LE(8),
    coinDecimals: Number(data.readBigUInt64LE(32)),
    pcDecimals: Number(data.readBigUInt64LE(40)),
    tradeFeeNumerator: data.readBigUInt64LE(128 + 16),
    tradeFeeDenominator: data.readBigUInt64LE(128 + 24),
    needTakePnlCoin: data.readBigUInt64LE(192),
    needTakePnlPc: data.readBigUInt64LE(200),
    coinVault: readPubkeyHex(data, 336),
    pcVault: readPubkeyHex(data, 368),
    coinVaultMint: readPubkeyHex(data, 400),
    pcVaultMint: readPubkeyHex(data, 432),
    lpMint: readPubkeyHex(data, 464),
    openOrders: readPubkeyHex(data, 496),
    market: readPubkeyHex(data, 528),
    marketProgram: readPubkeyHex(data, 560),
    targetOrders: readPubkeyHex(data, 592),
    ammOwner: readPubkeyHex(data, 688),
  };
}

/// Fetch an AmmInfo from the given Solana RPC endpoint. `rpcUrl` is the
/// cardo proxy route (e.g. '/api/rpc/solana-devnet').
export async function fetchRaydiumAmmV4Pool(
  rpcUrl: string,
  poolBs58: string,
): Promise<RaydiumAmmV4Pool> {
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
    throw new Error(`raydium-amm-v4: pool ${poolBs58} not found on this RPC`);
  }
  const buf = Buffer.from(value.data[0], 'base64');
  return decodeRaydiumAmmV4Pool(buf, pubkeyBs58ToBytes32(poolBs58));
}

/// Pools whose `status` field allows swap. Per AmmStatus enum in
/// state.rs: Initialized(1) / SwapOnly(6) / WaitingTrade(7).
export function poolPermitsSwap(pool: { status: bigint }): boolean {
  const s = Number(pool.status);
  return (
    s === AMM_STATUS_INITIALIZED ||
    s === AMM_STATUS_SWAP_ONLY ||
    s === AMM_STATUS_WAITING_TRADE
  );
}

// ─────────────────────────────────────────────────────────────────────
// Curated registry — pools Cardo's `/swap-raydium-amm` UI ships with.
//
// Devnet pool: USDC (devnet) ↔ WSOL — verified live 2026-04-26 with
// healthy reserves (30.4 USDC + 38.76 SOL effective). Among the 27
// status-active WSOL/USDC pairs on the devnet redeploy, this one had
// the deepest liquidity and a confirmed prior `swap_base_in` invocation
// (sig 512rcyahXgnLW…, ~28k CU consumed, ray_log emitted).
//
// Note: AMM v4 stores token_0 as `coin` and token_1 as `pc`. The seeded
// pool has coin = USDC (decimals 6) and pc = WSOL (decimals 9) — the
// opposite of CPMM's convention. The registry preserves the on-chain
// orientation; the UI maps {token0, token1} → {coin, pc}.
// ─────────────────────────────────────────────────────────────────────

export type RaydiumAmmV4SerumKeys = {
  /// Serum DEX program (OpenBook on devnet AMM v4 at EoTcMgcDRTJ…).
  program: Hex;
  /// Serum Market account.
  market: Hex;
  bids: Hex;
  asks: Hex;
  eventQueue: Hex;
  /// Serum's base-side vault (the "coin" side in serum's convention —
  /// orientation depends on the market, NOT the AMM v4 pool).
  coinVault: Hex;
  /// Serum's quote-side vault.
  pcVault: Hex;
  /// PDA([market, vault_signer_nonce], serum_program). Pre-derived from
  /// MarketState.vault_signer_nonce (u64 LE, NOT a bump search).
  vaultSigner: Hex;
};

export type RaydiumAmmV4PoolEntry = {
  /// Display label.
  label: string;
  /// Pool account bs58.
  poolBs58: string;
  /// Pool account hex (bytes32).
  poolHex: Hex;
  /// AMM authority (global PDA — same for every pool, but pinned per-entry
  /// so the entry is fully self-contained).
  authority: Hex;
  /// AMM open_orders account.
  openOrders: Hex;
  /// AMM target_orders account.
  targetOrders: Hex;
  /// AMM coin vault (token_0 side).
  coinVault: Hex;
  /// AMM pc vault (token_1 side).
  pcVault: Hex;
  /// Coin (token_0) mint hex.
  coinMint: Hex;
  /// Pc (token_1) mint hex.
  pcMint: Hex;
  /// Decimals for each side.
  coinDecimals: number;
  pcDecimals: number;
  /// SPL Token program for each side. AMM v4 pre-dates Token-2022, so
  /// every active pool uses classic SPL Token (Tokenkeg…).
  tokenProgram: Hex;
  /// Serum / OpenBook keys for this pool.
  serum: RaydiumAmmV4SerumKeys;
  /// Network the pool lives on.
  network: 'devnet' | 'mainnet';
  enabled: boolean;
};

const SPL_TOKEN_PROGRAM_HEX: Hex = pubkeyBs58ToBytes32(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
);

// Verified live 2026-04-26 against the devnet redeploy at HWy1jot…:
//   - pool 8Mwd2xFB AmmInfo.status = 6 (SwapOnly) ✓
//   - prior successful swap_base_in: sig 512rcyahXgnLW… (28238 CU)
//   - reserves: 30.388411 USDC + 38.764598 SOL
//   - serum_vault_signer derived from MarketState.vault_signer_nonce=1
const USDC_WSOL_DEVNET: RaydiumAmmV4PoolEntry = {
  label: 'USDC ↔ WSOL · devnet (AMM v4)',
  poolBs58: '8Mwd2xFBRNDGXPiGPx79e1xkWqJaUoQoGhx8vavZcfsQ',
  poolHex: pubkeyBs58ToBytes32('8Mwd2xFBRNDGXPiGPx79e1xkWqJaUoQoGhx8vavZcfsQ'),
  authority: pubkeyBs58ToBytes32(
    'DbQqP6ehDYmeYjcBaMRuA8tAJY1EjDUz9DpwSLjaQqfC',
  ),
  openOrders: pubkeyBs58ToBytes32(
    '9Y2AEfPjo2QGAdWvroTMzrmxHFvoHuVeM9nHTw37sdwt',
  ),
  targetOrders: pubkeyBs58ToBytes32(
    'FMNAkNtr3kNAhEmhcSV2Mb1crm2xBCK7EUJR3CD9PBxZ',
  ),
  coinVault: pubkeyBs58ToBytes32(
    'FxVQJDy3rDUPvG9kqgR2HjQWVbFVYaABsCXNEKYZvkqQ',
  ),
  pcVault: pubkeyBs58ToBytes32(
    '3sYJhZBztqPsUyczxzFekRh9UkZSBATv1994TNySJLha',
  ),
  // coin = USDC (6 dp), pc = WSOL (9 dp) — opposite of CPMM convention.
  coinMint: pubkeyBs58ToBytes32(
    '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  ),
  pcMint: pubkeyBs58ToBytes32('So11111111111111111111111111111111111111112'),
  coinDecimals: 6,
  pcDecimals: 9,
  tokenProgram: SPL_TOKEN_PROGRAM_HEX,
  serum: {
    program: pubkeyBs58ToBytes32(
      'EoTcMgcDRTJVZDMZWBoU6rhYHZfkNTVEAfz3uUJRcYGj',
    ),
    market: pubkeyBs58ToBytes32(
      'G9Yngf4PRYfzRgdACM1ku6PWe6Z3GhW7PPpX41LD6SYL',
    ),
    bids: pubkeyBs58ToBytes32('AxQpHJBsxQjm9MLKaYT7W4qszPiueZZtAMEAbeVpjxy2'),
    asks: pubkeyBs58ToBytes32('A2zxgckJ9SRqe8tJgYgjQgDZxKyJ19n9CvmmzdRXdCFL'),
    eventQueue: pubkeyBs58ToBytes32(
      'AruJx9YLmAm5qDDZL4bq6qf65Et3U4r8kixrwy9ZDePD',
    ),
    coinVault: pubkeyBs58ToBytes32(
      'GRW3FzRJUJzjhErjjgE6L6b48FBZi55N3Eki554532CH',
    ),
    pcVault: pubkeyBs58ToBytes32(
      '8BZ4npWpnrko4ffPUnVS7A4WgwKdoufk346e2SCsPbu4',
    ),
    vaultSigner: pubkeyBs58ToBytes32(
      '8FRYAtBfLL7GM1xZGJiJRivaNnGPLMaxFLnUiCJgTvKQ',
    ),
  },
  network: 'devnet',
  enabled: true,
} as const;

export const RAYDIUM_AMM_V4_POOL_REGISTRY: ReadonlyArray<RaydiumAmmV4PoolEntry> =
  [USDC_WSOL_DEVNET];

export const ENABLED_RAYDIUM_AMM_V4_POOLS: ReadonlyArray<RaydiumAmmV4PoolEntry> =
  RAYDIUM_AMM_V4_POOL_REGISTRY.filter((p) => p.enabled);

// ─────────────────────────────────────────────────────────────────────
// Constant-product (x*y=k) quote with Raydium AMM v4's fee schedule.
//
// AMM v4 applies the trade fee on input BEFORE the CP math:
//
//   amount_in_after_fee = amount_in * (denom - num) / denom    (integer floor)
//   amount_out          = amount_in_after_fee * out_reserve
//                          / (in_reserve + amount_in_after_fee)
//
// Default: trade_fee_numerator=25, trade_fee_denominator=10000 → 25 bps.
// Pool 8Mwd2xFB devnet reports the defaults. Real swaps may go through
// the orderbook (serum CPI inside swap_base_in) for better pricing —
// this quote is only the "AMM-side" worst case. UI should clamp slippage.
// ─────────────────────────────────────────────────────────────────────

export function quoteRaydiumAmmV4SwapBaseIn(
  inputReserve: bigint,
  outputReserve: bigint,
  amountIn: bigint,
  tradeFeeNumerator: bigint,
  tradeFeeDenominator: bigint,
): bigint {
  if (amountIn <= 0n) return 0n;
  if (inputReserve <= 0n || outputReserve <= 0n) return 0n;
  if (tradeFeeDenominator <= 0n) return 0n;
  const amountInAfterFee =
    (amountIn * (tradeFeeDenominator - tradeFeeNumerator)) /
    tradeFeeDenominator;
  if (amountInAfterFee <= 0n) return 0n;
  const num = amountInAfterFee * outputReserve;
  const den = inputReserve + amountInAfterFee;
  return num / den;
}
