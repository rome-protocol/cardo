// Raydium AMM v4 quote.
//
// Constant-product math (x * y = k). Read pool reserves, apply fee, compute
// output. v4 fee is encoded in the AMM config but in practice 0.25% (LP) +
// 0.03% (protocol) for all top USDC/SOL pools.
//
// Pool data offsets verified against
//   https://github.com/raydium-io/raydium-sdk-v2/blob/master/src/raydium/liquidity/layout.ts
// Layout `liquidityStateV4` — a packed struct. We only read the two key fields:
//   pool_coin_token_account / pool_pc_token_account (= reserve token accounts)
// Then we read those two token accounts to get reserves.

import type { Connection } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import type { Hex } from 'viem';
import { bytes32ToPublicKey, pubkeyToBytes32 } from '../../solana-pda';
import type { Quote, FailedQuote } from '../types';

// Raydium AMM v4 layout — relevant offsets (in bytes):
//   poolCoinTokenAccount (32 bytes) at offset 336
//   poolPcTokenAccount   (32 bytes) at offset 368
const OFFSET_POOL_COIN_VAULT = 336;
const OFFSET_POOL_PC_VAULT = 368;
const OFFSET_BASE_DECIMAL = 32;       // u64
const OFFSET_QUOTE_DECIMAL = 40;      // u64
const POOL_DATA_MIN_LEN = 752;
const FEE_NUMERATOR = 25n;            // 0.25% — typical Raydium v4
const FEE_DENOMINATOR = 10000n;

export type RaydiumAmmV4QuoteArgs = {
  conn: Connection;
  poolHex: Hex;
  /// Which side of the pool is "input"? true = baseIn (coin → pc), false = pcIn (pc → coin).
  baseIn: boolean;
  amountIn: bigint;
};

export async function quoteRaydiumAmmV4(
  args: RaydiumAmmV4QuoteArgs,
): Promise<Quote | FailedQuote> {
  const { conn, poolHex, baseIn, amountIn } = args;
  const venue = 'raydium-amm-v4' as const;
  try {
    const poolPk = bytes32ToPublicKey(poolHex);
    const acct = await conn.getAccountInfo(poolPk);
    if (!acct) return { venue, poolAddress: poolHex, error: 'pool not found' };
    if (acct.data.length < POOL_DATA_MIN_LEN) {
      return { venue, poolAddress: poolHex, error: `pool data ${acct.data.length}B < ${POOL_DATA_MIN_LEN}B` };
    }

    const coinVault = new PublicKey(acct.data.subarray(OFFSET_POOL_COIN_VAULT, OFFSET_POOL_COIN_VAULT + 32));
    const pcVault = new PublicKey(acct.data.subarray(OFFSET_POOL_PC_VAULT, OFFSET_POOL_PC_VAULT + 32));

    // Read reserve balances from the two vaults (they are SPL ATA-style accounts).
    // SPL Token account: amount is at offset 64, u64 LE.
    const [coinAcct, pcAcct] = await conn.getMultipleAccountsInfo([coinVault, pcVault]);
    if (!coinAcct || !pcAcct) {
      return { venue, poolAddress: poolHex, error: 'reserve vault missing' };
    }
    const coinReserve = coinAcct.data.readBigUInt64LE(64);
    const pcReserve = pcAcct.data.readBigUInt64LE(64);

    // Constant-product: amountOut = reserveOut - k / (reserveIn + amountInPostFee)
    const reserveIn = baseIn ? coinReserve : pcReserve;
    const reserveOut = baseIn ? pcReserve : coinReserve;
    if (reserveIn === 0n || reserveOut === 0n) {
      return { venue, poolAddress: poolHex, error: 'pool empty' };
    }

    const amountInPostFee = (amountIn * (FEE_DENOMINATOR - FEE_NUMERATOR)) / FEE_DENOMINATOR;
    const k = reserveIn * reserveOut;
    const newReserveIn = reserveIn + amountInPostFee;
    const newReserveOut = k / newReserveIn;
    const amountOut = reserveOut - newReserveOut;

    // Spot price = reserveOut / reserveIn (output per unit input, raw units).
    const spotPrice = Number(reserveOut) / Number(reserveIn);

    // Price impact: (spotPrice - effectivePrice) / spotPrice
    const effectivePrice = Number(amountOut) / Number(amountIn);
    const priceImpactBps = Math.round(((spotPrice - effectivePrice) / spotPrice) * 10_000);

    return {
      venue,
      poolAddress: poolHex,
      amountOut,
      spotPrice,
      priceImpactBps,
      estimatedCu: 80_000, // Raydium AMM v4 swap baseline
    };
  } catch (e) {
    return { venue, poolAddress: poolHex, error: (e as Error).message ?? String(e) };
  }
}

void pubkeyToBytes32; // (re-exported for any callers needing reverse direction)
