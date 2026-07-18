// Orchestrator — top-level public API.
//
// Quote across all configured venues, pick the best route, build a bundle.
// Submit via Jito-compatible endpoint.
//
// Usage:
//   const route = await orchestrate({
//     intent,
//     venues: [
//       { venue: 'orca-whirlpool',   pool: ORCA_USDC_SOL_30 },
//       { venue: 'raydium-amm-v4',   pool: RAY_USDC_SOL,    baseIn: false },
//       // ... add more as cloned
//     ],
//     conn,
//   });
//   console.log('best:', route.best.venue, route.best.amountOut);

import type { Connection } from '@solana/web3.js';
import type { Intent, Route, Quote, FailedQuote, Venue } from './types';
import { quoteRaydiumAmmV4 } from './quotes/raydium-amm-v4';
import { quoteOrcaWhirlpool } from './quotes/orca-whirlpool';

export type VenueConfig =
  | { venue: 'orca-whirlpool'; pool: `0x${string}`; aToB: boolean; decimalsIn: number; decimalsOut: number }
  | { venue: 'raydium-amm-v4'; pool: `0x${string}`; baseIn: boolean };

export type OrchestrateArgs = {
  intent: Intent;
  venues: VenueConfig[];
  conn: Connection;
};

export async function orchestrate(args: OrchestrateArgs): Promise<Route> {
  const { intent, venues, conn } = args;
  if (intent.kind !== 'swap') throw new Error(`only 'swap' intents supported in v1`);

  // Quote each venue in parallel.
  const results = await Promise.all(
    venues.map(async (v): Promise<Quote | FailedQuote> => {
      switch (v.venue) {
        case 'raydium-amm-v4':
          return quoteRaydiumAmmV4({
            conn,
            poolHex: v.pool,
            baseIn: v.baseIn,
            amountIn: intent.amountIn,
          });
        case 'orca-whirlpool':
          return quoteOrcaWhirlpool({
            conn,
            poolHex: v.pool,
            aToB: v.aToB,
            amountIn: intent.amountIn,
            decimalsIn: v.decimalsIn,
            decimalsOut: v.decimalsOut,
          });
        default:
          return { venue: 'orca-whirlpool' as Venue, error: `unsupported venue: ${(v as { venue: string }).venue}` };
      }
    }),
  );

  const success = results.filter((r): r is Quote => 'amountOut' in r);
  const failed = results.filter((r): r is FailedQuote => 'error' in r);

  if (success.length === 0) {
    throw new Error(`all venues failed: ${failed.map(f => `${f.venue}: ${f.error}`).join('; ')}`);
  }

  // Picker: highest amountOut wins (no slippage modeling in v1).
  // Future: factor in CU cost, price impact tolerance, multi-hop split.
  const best = success.reduce((a, b) => (b.amountOut > a.amountOut ? b : a));
  const alternates = success.filter(q => q !== best);

  return { intent, best, alternates, failed };
}

export type { Intent, Quote, Route, FailedQuote, Venue, SwapIntent } from './types';
