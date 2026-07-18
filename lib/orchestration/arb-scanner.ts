// Arb opportunity scanner — the user's intent:
//   "I have $X. Find me an arb that makes money NET of tip + fees + slippage.
//    If no profitable opportunity, don't execute."
//
// Strategy:
//   1. Quote a token pair across N DEX pools.
//   2. The "buy on cheap pool, sell on expensive pool" round-trip output
//      is the arb output for a given principal.
//   3. Subtract all real costs (Jito tip, Solana fees, non-recoverable rent).
//   4. Decide: execute (net > threshold), or report "no opportunity".
//
// Pairs scanned today (mainnet):
//   - SOL ↔ USDC across Raydium AMM v4, Orca whirlpool
//   - USDC ↔ USDT (often very tight, but instructive when divergent)
//   - JitoSOL ↔ SOL: stake-pool rate vs DEX pool rate (LST mispricing)
//
// All quotes are pure pool-state reads (no on-chain probes).

import type { Connection } from '@solana/web3.js';
import type { Hex } from 'viem';
import { quoteRaydiumAmmV4 } from './quotes/raydium-amm-v4';
import { quoteOrcaWhirlpool } from './quotes/orca-whirlpool';
import { pubkeyBs58ToBytes32 } from '../solana-pda';
import { getTipFloor, recommendTip } from './route-analysis';

// Mainnet pool addresses Cardo orchestrator quotes against.
// Same pool we used for swaps — verified mainnet liquidity.
const RAY_USDC_SOL = pubkeyBs58ToBytes32('58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2');
const ORCA_USDC_SOL_30BPS = pubkeyBs58ToBytes32('HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ');

const TX_FEE = 5000;       // lamports per Solana tx
const ATA_RENT_RECOVERED = 2_039_280;  // recoverable on close
const ATA_RENT_KEPT = 2_039_280;       // kept until user closes (effectively rent-locked capital, treated as cost)

export type ArbCandidate = {
  /// Display name e.g. "Raydium → Orca: SOL/USDC"
  label: string;
  /// Buy venue — where we acquire the output token cheaply.
  buyVenue: string;
  buyPool: string;
  /// Sell venue — where we sell the output token expensively.
  sellVenue: string;
  sellPool: string;
  /// Pair direction.
  inputMint: 'SOL' | 'USDC';
  outputMint: 'SOL' | 'USDC';
  /// For a given input lamports, output after round-trip.
  /// Defined as: buy on buyVenue (input → output), then sell on sellVenue (output → input).
  /// If positive, we ended with more input-token than we started.
  netInputLamports: bigint;
  /// Pretty-printed economics.
  inputPretty: string;
  outputPretty: string;
  spreadBps: number;
};

export type ArbDecision = {
  candidate: ArbCandidate;
  /// Total cost for executing this arb in lamports
  costLamports: number;
  costPretty: string;
  /// Profit (gross output - principal - cost). Negative means loss.
  pnlLamports: bigint;
  pnlPretty: string;
  /// Should we execute?
  decision: 'EXECUTE' | 'SKIP';
  reason: string;
};

const SOL_PRICE_USD = 200; // for human-readable output only

export type ScanInput = {
  conn: Connection;
  /// Principal in SOL (we quote SOL→USDC→SOL roundtrip for the SOL pair).
  principalLamports: bigint;
  /// Tip target — defaults to p99 from live floor for ~99% landing.
  /// Caller can pass a smaller tip for "low-confidence" probes.
  tipLamports?: number;
  /// Minimum acceptable PnL margin. Default $0.10 to avoid wasted gas on near-zero.
  minPnlLamports?: bigint;
};

/// Scan SOL/USDC roundtrip arbs.
/// "buy on Raydium, sell on Orca" + "buy on Orca, sell on Raydium" are both candidates.
export async function scanSolUsdcArbs(args: ScanInput): Promise<ArbDecision[]> {
  const principal = args.principalLamports;

  // Quote Raydium and Orca for the SOL/USDC pair, both directions.
  const rayBuyUsdc = await quoteRaydiumAmmV4({
    conn: args.conn, poolHex: RAY_USDC_SOL, baseIn: true, amountIn: principal,
  });
  const orcaBuyUsdc = await quoteOrcaWhirlpool({
    conn: args.conn, poolHex: ORCA_USDC_SOL_30BPS, aToB: true,
    amountIn: principal, decimalsIn: 9, decimalsOut: 6,
  });

  if (!('amountOut' in rayBuyUsdc) || !('amountOut' in orcaBuyUsdc)) {
    return [];
  }

  // Now for each "buy" leg, compute "sell" output (USDC → SOL) on the OTHER venue.
  const usdcOutFromRay = rayBuyUsdc.amountOut;   // raw USDC (6 dec)
  const usdcOutFromOrca = orcaBuyUsdc.amountOut; // raw USDC (6 dec)

  const orcaSellSol = await quoteOrcaWhirlpool({
    conn: args.conn, poolHex: ORCA_USDC_SOL_30BPS, aToB: false,
    amountIn: usdcOutFromRay, decimalsIn: 6, decimalsOut: 9,
  });
  const raySellSol = await quoteRaydiumAmmV4({
    conn: args.conn, poolHex: RAY_USDC_SOL, baseIn: false, amountIn: usdcOutFromOrca,
  });

  const candidates: ArbCandidate[] = [];

  // Path 1: Ray → Orca (buy USDC on Ray, sell USDC on Orca)
  if ('amountOut' in orcaSellSol) {
    const netSol = orcaSellSol.amountOut;
    const spreadBps = Math.round(((Number(netSol) - Number(principal)) / Number(principal)) * 10_000);
    candidates.push({
      label: 'Raydium → Orca: SOL/USDC roundtrip',
      buyVenue: 'Raydium AMM v4', buyPool: '58oQ…YQo2',
      sellVenue: 'Orca whirlpool', sellPool: 'HJPj…ngndJ',
      inputMint: 'SOL', outputMint: 'USDC',
      netInputLamports: netSol,
      inputPretty: `${(Number(principal) / 1e9).toFixed(6)} SOL  ($${(Number(principal) / 1e9 * SOL_PRICE_USD).toFixed(2)})`,
      outputPretty: `${(Number(netSol) / 1e9).toFixed(6)} SOL  ($${(Number(netSol) / 1e9 * SOL_PRICE_USD).toFixed(2)})`,
      spreadBps,
    });
  }

  // Path 2: Orca → Ray
  if ('amountOut' in raySellSol) {
    const netSol = raySellSol.amountOut;
    const spreadBps = Math.round(((Number(netSol) - Number(principal)) / Number(principal)) * 10_000);
    candidates.push({
      label: 'Orca → Raydium: SOL/USDC roundtrip',
      buyVenue: 'Orca whirlpool', buyPool: 'HJPj…ngndJ',
      sellVenue: 'Raydium AMM v4', sellPool: '58oQ…YQo2',
      inputMint: 'SOL', outputMint: 'USDC',
      netInputLamports: netSol,
      inputPretty: `${(Number(principal) / 1e9).toFixed(6)} SOL  ($${(Number(principal) / 1e9 * SOL_PRICE_USD).toFixed(2)})`,
      outputPretty: `${(Number(netSol) / 1e9).toFixed(6)} SOL  ($${(Number(netSol) / 1e9 * SOL_PRICE_USD).toFixed(2)})`,
      spreadBps,
    });
  }

  // Cost computation: arb bundle is 5-tx (tip + ATA setup + wrap + 2 swaps + close)
  //   Actually 6 because we need 2 swap ix. We'll pack 2 swaps into one tx if possible
  //   to keep the bundle at 5 — Raydium swap is 18 accounts which is tight.
  //   For costing assume 5-tx + ATA rent for 2 ATAs (USDC kept, WSOL recovered).
  const floor = await getTipFloor();
  const tip = args.tipLamports ?? Math.max(recommendTip(0.95, floor, 5), 3_000_000);
  const txCount = 5;
  const cost = tip + txCount * TX_FEE + ATA_RENT_KEPT; // USDC ATA stays open
  // (WSOL ATA closes in tx5 → recovered)

  const minPnl = args.minPnlLamports ?? 100_000n; // 0.0001 SOL = $0.02 minimum profit

  // Decide for each candidate.
  // Quote-bug sanity bound: positive spreads >500bps are almost certainly
  // quote-engine bugs (real arbs are gone in <1 slot). Negative spreads
  // are valid pool-fee+slippage signals, just unprofitable.
  const MAX_BUGGY_POSITIVE_BPS = 500;

  return candidates.map(c => {
    const pnl = c.netInputLamports - principal - BigInt(cost);
    let decision: 'EXECUTE' | 'SKIP';
    let reason: string;

    if (c.spreadBps > MAX_BUGGY_POSITIVE_BPS) {
      decision = 'SKIP';
      reason = `+${c.spreadBps}bps spread implausibly large — likely quote bug, not real arb`;
    } else if (pnl > minPnl) {
      decision = 'EXECUTE';
      reason = `profit ${(Number(pnl) / 1e9 * SOL_PRICE_USD).toFixed(4)} above $${(Number(minPnl) / 1e9 * SOL_PRICE_USD).toFixed(4)} threshold`;
    } else if (pnl > 0n) {
      decision = 'SKIP';
      reason = `marginally profitable (+${(Number(pnl) / 1e9 * SOL_PRICE_USD).toFixed(6)}) but below min-PnL threshold`;
    } else {
      // Unprofitable. Distinguish "spread is positive but cost > spread" vs
      // "spread itself is negative (slippage)."
      if (c.spreadBps > 0) {
        reason = `spread +${c.spreadBps}bps is real but doesn't cover bundle cost ($${(cost / 1e9 * SOL_PRICE_USD).toFixed(3)})`;
      } else {
        reason = `spread ${c.spreadBps}bps — slippage > arb. Pool too thin for this principal.`;
      }
      decision = 'SKIP';
    }

    return {
      candidate: c,
      costLamports: cost,
      costPretty: `${cost} lamports = ${(cost / 1e9).toFixed(6)} SOL ($${(cost / 1e9 * SOL_PRICE_USD).toFixed(3)})`,
      pnlLamports: pnl,
      pnlPretty: `${pnl > 0n ? '+' : ''}${(Number(pnl) / 1e9).toFixed(9)} SOL ($${(Number(pnl) / 1e9 * SOL_PRICE_USD).toFixed(4)})`,
      decision,
      reason,
    };
  });
}

/// Compute breakeven principal for a given spread.
/// Tells the orchestrator/UI: "for this spread, you need at least $X to make money."
export function breakevenPrincipal(spreadBps: number, costLamports: number): number {
  if (spreadBps <= 0) return Infinity;
  // pnl = principal × (spreadBps / 10000) - cost
  // breakeven: principal = cost × 10000 / spreadBps
  return Math.ceil(costLamports * 10_000 / spreadBps);
}
