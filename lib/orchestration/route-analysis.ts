// User-intent → ranked route options.
//
// Mental model: orchestrator takes one "intent" (a high-level user goal) and
// returns N candidate routes. Each route is a complete, runnable bundle plan
// with cost / output / probability metrics — exactly what a UI would show
// the user as "1 / 2 / 3 — pick one".
//
// Intent types covered:
//   * SwapIntent      — "swap X of A for B"
//   * StakeIntent     — "stake N SOL → LST" (compares JitoSOL / bSOL / mSOL)
//   * YieldIntent     — "park N TOKEN as yield" (compares Kamino / Mango / Drift)
//
// Each ranked Route reports:
//   - hops:       protocols involved (1 hop = direct, 2+ = multi-protocol)
//   - amountOut:  expected output token amount (post-slippage)
//   - costSol:    total SOL cost (tx fees + tip + ATA rents - recoverable)
//   - tipNeeded:  Jito tip for ~95% landing prob (calibrated to live tip_floor)
//   - landProb:   estimated landing probability at the chosen tip
//
// User picks 1/2/3 → orchestrator runs that route's bundle plan via submitBundle.

import type { Connection } from '@solana/web3.js';
import type { Hex } from 'viem';
import { quoteRaydiumAmmV4 } from './quotes/raydium-amm-v4';
import { quoteOrcaWhirlpool } from './quotes/orca-whirlpool';
import { pubkeyBs58ToBytes32 } from '../solana-pda';
import { applyCardoFee } from './config';

/// Helper: format Cardo fee fields against a gross amountOut and a
/// per-token formatter. Keeps each `routes.push` site terse.
function withFee(
  grossAmountOut: bigint,
  format: (raw: bigint) => string,
): {
  feeBps: number;
  feeAmount: bigint;
  feePretty: string;
  userReceives: bigint;
  userReceivesPretty: string;
} {
  const { feeAmount, userReceives, feeBps } = applyCardoFee(grossAmountOut);
  return {
    feeBps,
    feeAmount,
    feePretty: format(feeAmount),
    userReceives,
    userReceivesPretty: format(userReceives),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Live tip-floor cache — refreshed lazily; orchestrator UI would refresh
// this every 30s and feed it into landing-probability calculations.
// ─────────────────────────────────────────────────────────────────────

export type TipFloor = {
  fetchedAt: number;
  p25: number; // lamports
  p50: number;
  p75: number;
  p95: number;
  p99: number;
};

let TIP_CACHE: TipFloor | null = null;
const TIP_CACHE_TTL_MS = 30_000;

export async function getTipFloor(): Promise<TipFloor> {
  if (TIP_CACHE && Date.now() - TIP_CACHE.fetchedAt < TIP_CACHE_TTL_MS) return TIP_CACHE;
  try {
    const r = await fetch('https://bundles.jito.wtf/api/v1/bundles/tip_floor');
    const arr = (await r.json()) as Array<Record<string, number>>;
    if (!arr?.length) throw new Error('empty tip_floor');
    const e = arr[0];
    TIP_CACHE = {
      fetchedAt: Date.now(),
      p25: Math.round(e.landed_tips_25th_percentile * 1e9),
      p50: Math.round(e.landed_tips_50th_percentile * 1e9),
      p75: Math.round(e.landed_tips_75th_percentile * 1e9),
      p95: Math.round(e.landed_tips_95th_percentile * 1e9),
      p99: Math.round(e.landed_tips_99th_percentile * 1e9),
    };
  } catch (_e) {
    // Fallback to empirically observed ranges from this project's testing
    TIP_CACHE = { fetchedAt: Date.now(), p25: 1500, p50: 3000, p75: 8500, p95: 75000, p99: 1_600_000 };
  }
  return TIP_CACHE;
}

/// Estimate landing probability given a chosen tip + bundle complexity.
/// Empirical model based on this project's testing:
///   - tip < p50         → ~25% (small bundles only; even then unreliable)
///   - tip ≈ p75         → ~70%
///   - tip ≈ p95         → ~95% for ≤2-tx; ~80% for 5-tx
///   - tip ≥ p99         → ~99% for any bundle ≤5 tx
/// 5-tx bundles deprioritize because they consume more bundle bandwidth.
export function landProb(tip: number, floor: TipFloor, txCount: number): number {
  const sizeAdjust = txCount <= 2 ? 1.0 : txCount <= 4 ? 0.92 : 0.80;
  let base: number;
  if (tip < floor.p50) base = 0.25;
  else if (tip < floor.p75) base = 0.55;
  else if (tip < floor.p95) base = 0.80;
  else if (tip < floor.p99) base = 0.95;
  else base = 0.99;
  return Math.min(0.99, base * sizeAdjust);
}

/// Recommend a tip that hits target landing probability for a given bundle size.
/// Returns the cheapest tip percentile that meets the target.
export function recommendTip(target: number, floor: TipFloor, txCount: number): number {
  for (const tip of [floor.p25, floor.p50, floor.p75, floor.p95, floor.p99, floor.p99 * 2]) {
    if (landProb(tip, floor, txCount) >= target) return tip;
  }
  return floor.p99 * 2;
}

// ─────────────────────────────────────────────────────────────────────
// Route type — what the UI gets per option
// ─────────────────────────────────────────────────────────────────────

export type Route = {
  /// Display label, e.g. "Raydium AMM v4 (USDC/SOL pool)"
  label: string;
  /// Protocol hops the route uses, in order.
  hops: string[];
  /// Total tx count in the bundle (drives tip + landing prob).
  txCount: number;
  /// Solana SPL mint of the input side (base58). Lets the executor know
  /// what to consume. Optional for backward-compat with intents that
  /// were defaulted by the analyzer (swap → WSOL).
  inputMint?: string;
  /// Solana SPL mint of the output side (base58). Critical for the
  /// build endpoint to wire Jupiter swaps with the right destination.
  /// For stake routes this is the LST mint; for swap it's the dest token;
  /// for yield it's the supply token (the lending share is implicit).
  outputMint?: string;
  /// Expected gross output amount in destination mint smallest units, BEFORE
  /// Cardo's take-rate fee. -1 if not quoted.
  amountOut: bigint;
  /// Pretty-printed gross output (e.g. "0.4192 USDC"), for the UI.
  amountOutPretty: string;
  /// Total Solana-side cost in lamports: tx fees + Jito tip + non-recoverable
  /// ATA rents. Excludes Cardo's fee (which comes out of output).
  costLamports: number;
  costPretty: string;
  /// Tip selected for ~95% landing.
  tipLamports: number;
  /// Estimated landing probability at that tip.
  landingProb: number;
  /// Cardo take-rate fee in bps applied to amountOut.
  feeBps: number;
  /// Cardo's fee, in OUTPUT mint smallest units.
  feeAmount: bigint;
  feePretty: string;
  /// What the user actually receives after Cardo's fee. = amountOut - feeAmount.
  userReceives: bigint;
  userReceivesPretty: string;
  /// Free-form notes (dev / diagnostic).
  notes?: string[];
};

// ─────────────────────────────────────────────────────────────────────
// Intent → Route[] dispatch
// ─────────────────────────────────────────────────────────────────────

const USDC = pubkeyBs58ToBytes32('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const WSOL = pubkeyBs58ToBytes32('So11111111111111111111111111111111111111112');
const ORCA_USDC_SOL_30BPS = pubkeyBs58ToBytes32('HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ');
const RAY_USDC_SOL = pubkeyBs58ToBytes32('58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2');

const TX_FEE = 5000;
const ATA_RENT = 2_039_280;

/// "Swap N SOL for USDC" — compare DEX routes.
export async function analyzeSwapIntent(args: {
  conn: Connection;
  amountInLamports: bigint;
  inputMint?: Hex;
  outputMint?: Hex;
  targetLandProb?: number;
}): Promise<Route[]> {
  const targetProb = args.targetLandProb ?? 0.95;
  const floor = await getTipFloor();
  const inputMint = args.inputMint ?? WSOL;
  const outputMint = args.outputMint ?? USDC;
  const isSolIn = inputMint === WSOL;

  const routes: Route[] = [];

  // Route A — Raydium AMM v4
  const ray = await quoteRaydiumAmmV4({
    conn: args.conn,
    poolHex: RAY_USDC_SOL,
    baseIn: isSolIn,
    amountIn: args.amountInLamports,
  });
  if ('amountOut' in ray) {
    // Single-tx atomic flow. "Cost" here = the user's NON-RECOVERABLE
    // outlay: base tx fee + ~priority fee. The output ATA rent
    // (~0.002 SOL) is technically a deposit, not a fee — closing the
    // ATA later refunds it, so we don't count it as cost.
    const txCount = 1;
    const tip = 0;
    const cost = TX_FEE + 5000;
    const usdcFmt = (raw: bigint) => `${(Number(raw) / 1e6).toFixed(6)} USDC`;
    routes.push({
      label: 'Raydium AMM v4 (direct)',
      hops: ['Raydium AMM v4'],
      txCount,
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      amountOut: ray.amountOut,
      amountOutPretty: usdcFmt(ray.amountOut),
      costLamports: cost,
      costPretty: `~${(cost / 1e9).toFixed(6)} SOL ($${(cost * 200 / 1e9).toFixed(3)})`,
      tipLamports: tip,
      landingProb: landProb(tip, floor, txCount),
      ...withFee(ray.amountOut, usdcFmt),
      notes: [`impact ${ray.priceImpactBps}bps`, `est. ${ray.estimatedCu} CU`],
    });
  }

  // Route B — Orca whirlpool (math approximation; doesn't reliably quote yet)
  const orca = await quoteOrcaWhirlpool({
    conn: args.conn,
    poolHex: ORCA_USDC_SOL_30BPS,
    aToB: isSolIn,
    amountIn: args.amountInLamports,
    decimalsIn: 9,
    decimalsOut: 6,
  });
  if ('amountOut' in orca && orca.amountOut > 0n) {
    const txCount = 1;
    const tip = 0;
    const cost = TX_FEE + 5000;
    const usdcFmt = (raw: bigint) => `${(Number(raw) / 1e6).toFixed(6)} USDC`;
    routes.push({
      label: 'Orca whirlpool (direct)',
      hops: ['Orca Whirlpool'],
      txCount,
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      amountOut: orca.amountOut,
      amountOutPretty: usdcFmt(orca.amountOut),
      costLamports: cost,
      costPretty: `~${(cost / 1e9).toFixed(6)} SOL ($${(cost * 200 / 1e9).toFixed(3)})`,
      tipLamports: tip,
      landingProb: landProb(tip, floor, txCount),
      ...withFee(orca.amountOut, usdcFmt),
      notes: ['sqrtPrice approximation; production: walk tick arrays'],
    });
  }

  // Sort: best amountOut first, then by lowest cost.
  routes.sort((a, b) => {
    if (a.amountOut !== b.amountOut) return a.amountOut > b.amountOut ? -1 : 1;
    return a.costLamports - b.costLamports;
  });
  return routes;
}

/// "Stake N SOL → LST" — compare LST options.
/// Uses Cardo's stake-pool registry for known mainnet pools.
export async function analyzeStakeIntent(args: {
  conn: Connection;
  amountInLamports: bigint;
  targetLandProb?: number;
}): Promise<Route[]> {
  const targetProb = args.targetLandProb ?? 0.95;
  const floor = await getTipFloor();
  const routes: Route[] = [];

  // For LST stake-pools we'd ideally read pool's `total_lamports` and
  // `pool_token_supply` to compute the exchange rate. Stub it with the
  // known long-run rates for each — orchestrator UI in production reads
  // the live pool struct. Keeping this analysis-only for now.
  const stakeOptions = [
    {
      symbol: 'JitoSOL',
      mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
      apy: '~7.0%', rateExpected: 0.83, txCount: 1,
      notes: 'MEV-boosted, highest TVL LST',
    },
    {
      symbol: 'bSOL',
      mint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',
      apy: '~6.8%', rateExpected: 0.85, txCount: 1,
      notes: 'BlazeStake',
    },
    {
      symbol: 'mSOL',
      mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
      apy: '~7.0%', rateExpected: 0.84, txCount: 1,
      notes: 'Marinade — separate program; routed via Jupiter aggregation',
    },
    {
      symbol: 'JupSOL',
      mint: 'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v',
      apy: '~7.5%', rateExpected: 0.84, txCount: 1,
      notes: 'Jupiter LST — auto-rebalanced across validators',
    },
  ];

  for (const opt of stakeOptions) {
    // Single-tx flow (Jupiter routes SOL → LST atomically). No Jito tip.
    // ATA rent excluded (it's a recoverable deposit, not a fee).
    const tip = 0;
    const cost = TX_FEE + 5000;
    const out = BigInt(Math.floor(Number(args.amountInLamports) * opt.rateExpected));
    const lstFmt = (raw: bigint) => `${(Number(raw) / 1e9).toFixed(6)} ${opt.symbol}`;
    routes.push({
      label: `Stake → ${opt.symbol}`,
      hops: ['SPL stake-pool'],
      txCount: 1,
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: opt.mint,
      amountOut: out,
      amountOutPretty: `${lstFmt(out)}  (${opt.apy})`,
      costLamports: cost,
      costPretty: `~${(cost / 1e9).toFixed(6)} SOL ($${(cost * 200 / 1e9).toFixed(3)})`,
      tipLamports: tip,
      landingProb: landProb(tip, floor, opt.txCount),
      ...withFee(out, lstFmt),
      notes: [opt.notes],
    });
  }
  return routes;
}

/// "Park N USDC as yield" — peek at Kamino / Mango / Drift supply rates.
/// Production would read on-chain interest accrual + utilization curves;
/// here we surface representative APYs to make the UI shape concrete.
export async function analyzeYieldIntent(args: {
  conn: Connection;
  amountInUsdcRaw: bigint;
  targetLandProb?: number;
}): Promise<Route[]> {
  void args.conn;
  const targetProb = args.targetLandProb ?? 0.95;
  const floor = await getTipFloor();

  // Each is a 5-tx Cardo bundle: tip + ATA setup + refresh oracle + supply ix + done.
  // Different protocols, different APY/risk profiles.
  const yieldOptions = [
    { protocol: 'Kamino',  market: 'Main USDC', apy: 5.2, hops: ['Kamino lend'],          txCount: 5 },
    { protocol: 'Mango v4', market: 'USDC bank', apy: 4.8, hops: ['Mango v4'],             txCount: 5 },
    { protocol: 'Drift',   market: 'USDC spot', apy: 4.1, hops: ['Drift v2'],             txCount: 5 },
  ];

  const routes: Route[] = [];
  for (const o of yieldOptions) {
    const tip = recommendTip(targetProb, floor, o.txCount);
    const cost = tip + o.txCount * TX_FEE + ATA_RENT * 2; // 2 ATAs (input USDC, share token)
    const usdcFmt = (raw: bigint) => `${(Number(raw) / 1e6).toFixed(6)} USDC`;
    routes.push({
      label: `${o.protocol} ${o.market}`,
      hops: o.hops,
      txCount: o.txCount,
      amountOut: args.amountInUsdcRaw, // 1:1 deposit; share-token represents claim
      amountOutPretty: `${usdcFmt(args.amountInUsdcRaw)} supply  @ ${o.apy.toFixed(1)}% APY`,
      ...withFee(args.amountInUsdcRaw, usdcFmt),
      costLamports: cost,
      costPretty: `~${(cost / 1e9).toFixed(6)} SOL ($${(cost * 200 / 1e9).toFixed(3)})`,
      tipLamports: tip,
      landingProb: landProb(tip, floor, o.txCount),
      notes: [`gross APY (excludes Cardo orchestration cost)`],
    });
  }
  // Best APY first
  return routes;
}

// ─────────────────────────────────────────────────────────────────────
// Pretty-print routes as a UI-shaped table
// ─────────────────────────────────────────────────────────────────────

export function printRouteTable(intent: string, routes: Route[]) {
  console.log(`\n=== Intent: "${intent}" — ${routes.length} routes ===\n`);
  if (routes.length === 0) {
    console.log('  (no viable routes found)\n');
    return;
  }
  routes.forEach((r, i) => {
    console.log(`  Option ${i + 1}: ${r.label}`);
    console.log(`    hops:        ${r.hops.join(' → ')}`);
    console.log(`    output:      ${r.amountOutPretty}`);
    console.log(`    cost:        ${r.costPretty}`);
    console.log(`    tip:         ${r.tipLamports} lamports`);
    console.log(`    land prob:   ${(r.landingProb * 100).toFixed(0)}%  (${r.txCount}-tx bundle)`);
    if (r.notes?.length) console.log(`    notes:       ${r.notes.join(', ')}`);
    console.log('');
  });
}
