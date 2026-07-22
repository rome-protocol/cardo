// POST /api/orchestrate — natural-language intent → ranked routes.
//
// Pipeline:
//   1. parseIntent(text)        text → structured Intent (LLM or heuristic)
//   2. analyze*Intent(...)      Intent → Route[] from on-chain state
//   3. rankRoutes(intent, ...)  Route[] → ranked + reasoned for the UI
//
// Stays server-side because:
//   - the Anthropic SDK key (ANTHROPIC_API_KEY) must not ship to the browser
//   - the @solana/web3.js Connection makes RPC reads against the configured
//     mainnet endpoint
//   - the Jito tip_floor fetch is cleaner from the server (no CORS dance)
//
// If ANTHROPIC_API_KEY is unset, parseIntent + rankRoutes fall back to
// deterministic heuristics — the route still works, just less natural.

import { NextRequest, NextResponse } from 'next/server';
import { parseIntent, rankRoutes } from '@/lib/orchestration/ai-router';
import { checkIntentText } from '@/lib/orchestration/intent-input';
import {
  analyzeSwapIntent,
  analyzeStakeIntent,
  analyzeYieldIntent,
  getTipFloor,
  recommendTip,
  landProb,
} from '@/lib/orchestration/route-analysis';
import type { Route } from '@/lib/orchestration/route-analysis';
import { scanSolUsdcArbs } from '@/lib/orchestration/arb-scanner';
import {
  applyCardoFee,
  CARDO_TREASURY_PUBKEY,
  CARDO_FEE_BPS,
  withRpcFailover,
  MAINNET_RPCS,
} from '@/lib/orchestration/config';

const SOL_PRICE_USD = 200;

/// Pull a principal-in-lamports out of whatever shape the LLM produced.
/// The model's `params` may carry any of: principalLamports / principalSol /
/// principalUsd / amountInSol / amountInUsd. We coerce here to a single
/// authoritative bigint instead of trusting the model's lamport math (which
/// it gets wrong with current SOL prices).
function coerceArbPrincipal(params: Record<string, unknown>): bigint {
  const usd =
    (params.principalUsd as number | undefined) ??
    (params.amountInUsd as number | undefined);
  if (typeof usd === 'number' && usd > 0) {
    return BigInt(Math.floor((usd / SOL_PRICE_USD) * 1e9));
  }
  const sol =
    (params.principalSol as number | undefined) ??
    (params.amountInSol as number | undefined);
  if (typeof sol === 'number' && sol > 0) {
    return BigInt(Math.floor(sol * 1e9));
  }
  const lamports = params.principalLamports as
    | number
    | string
    | bigint
    | undefined;
  if (typeof lamports === 'bigint') return lamports;
  if (typeof lamports === 'number' && lamports > 0) {
    return BigInt(Math.floor(lamports));
  }
  if (typeof lamports === 'string' && lamports) {
    return BigInt(lamports);
  }
  // Default: $10 worth of SOL.
  return BigInt(Math.floor((10 / SOL_PRICE_USD) * 1e9));
}

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  let body: { text?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json body' }, { status: 400 });
  }
  // Bound the free text before it reaches parseIntent's regexes (ReDoS guard).
  const checked = checkIntentText(body.text);
  if (!checked.ok) {
    return NextResponse.json({ error: checked.error }, { status: checked.status });
  }
  const text = checked.text;

  // Step 1: parse intent
  const intent = await parseIntent(text);
  if (intent.kind === 'unknown') {
    return NextResponse.json({ intent, ranked: [] });
  }

  // Step 2: compute routes (route-analysis hits Solana mainnet for live state)
  const targetLandProb = intent.preference === 'safest' ? 0.99 : 0.95;
  let routes: Route[] = [];

  try {
    if (intent.kind === 'swap') {
      const amountInSol =
        (intent.params.amountInSol as number | undefined) ?? 0.05;
      const amountIn = BigInt(Math.floor(amountInSol * 1e9));
      routes = await withRpcFailover((conn) =>
        analyzeSwapIntent({ conn, amountInLamports: amountIn, targetLandProb }),
      );
    } else if (intent.kind === 'stake') {
      const amountInSol =
        (intent.params.amountInSol as number | undefined) ?? 0.01;
      routes = await withRpcFailover((conn) =>
        analyzeStakeIntent({
          conn,
          amountInLamports: BigInt(Math.floor(amountInSol * 1e9)),
          targetLandProb,
        }),
      );
    } else if (intent.kind === 'yield') {
      const amountInUsdc =
        (intent.params.amountInUsdc as number | undefined) ?? 1;
      routes = await withRpcFailover((conn) =>
        analyzeYieldIntent({
          conn,
          amountInUsdcRaw: BigInt(Math.floor(amountInUsdc * 1e6)),
          targetLandProb,
        }),
      );
    } else if (intent.kind === 'compose') {
      // Compose: just emit one synthetic Route describing the chain.
      // Per-step build/execute is handled at submit time via build-compose.
      const steps = (intent.params.steps as Array<{
        kind: string;
        summary: string;
      }>) ?? [];
      const label =
        steps.length > 0
          ? `Compose: ${steps.map((s) => s.kind).join(' → ')}`
          : 'Compose';
      routes = [
        {
          label,
          hops: steps.map((s) => s.summary || s.kind),
          txCount: steps.length || 1,
          inputMint: undefined,
          outputMint: undefined,
          amountOut: 0n,
          amountOutPretty: `${steps.length} chained step${
            steps.length === 1 ? '' : 's'
          }`,
          costLamports: 5000 * Math.max(1, steps.length),
          costPretty: `~${(0.000005 * Math.max(1, steps.length)).toFixed(6)} SOL ($${(0.000005 * Math.max(1, steps.length) * 200).toFixed(3)})`,
          tipLamports: 0,
          landingProb: 0.99,
          feeBps: 30,
          feeAmount: 0n,
          feePretty: 'per-step',
          userReceives: 0n,
          userReceivesPretty: 'see steps below',
          notes: steps.map((s, i) => `step ${i + 1}: ${s.summary || s.kind}`),
        },
      ];
    } else if (intent.kind === 'arb') {
      // Arb intent: scan SOL/USDC across Raydium AMM v4 + Orca whirlpool.
      // Each ArbDecision becomes a Route with the EXECUTE/SKIP verdict
      // surfaced via notes — the AI ranker can then explain why.
      const principalLamports = coerceArbPrincipal(intent.params);
      const floor = await getTipFloor();
      const tip = Math.max(recommendTip(targetLandProb, floor, 5), 3_000_000);
      const decisions = await withRpcFailover((conn) =>
        scanSolUsdcArbs({ conn, principalLamports, tipLamports: tip }),
      );
      const txCount = 5;
      routes = decisions.map((d) => {
        const verdict = d.decision === 'EXECUTE' ? '★ EXECUTE' : '⊘ SKIP';
        const solFmt = (raw: bigint) =>
          `${(Number(raw) / 1e9).toFixed(6)} SOL ($${(Number(raw) / 1e9 * SOL_PRICE_USD).toFixed(2)})`;
        const { feeAmount, userReceives, feeBps } = applyCardoFee(
          d.candidate.netInputLamports,
        );
        return {
          label: `${verdict} · ${d.candidate.label}`,
          hops: [d.candidate.buyVenue, d.candidate.sellVenue],
          txCount,
          amountOut: d.candidate.netInputLamports,
          amountOutPretty: d.candidate.outputPretty,
          costLamports: d.costLamports,
          costPretty: d.costPretty,
          tipLamports: tip,
          landingProb: landProb(tip, floor, txCount),
          feeBps,
          feeAmount,
          feePretty: solFmt(feeAmount),
          userReceives,
          userReceivesPretty: solFmt(userReceives),
          notes: [
            `principal: ${d.candidate.inputPretty}`,
            `spread: ${d.candidate.spreadBps > 0 ? '+' : ''}${d.candidate.spreadBps} bps`,
            `pnl: ${d.pnlPretty}`,
            `decision: ${d.decision} — ${d.reason}`,
          ],
        };
      });
    } else {
      return NextResponse.json({
        intent,
        ranked: [],
        note: `intent kind "${intent.kind}" not yet wired in this orchestrator surface`,
      });
    }
  } catch (e) {
    return NextResponse.json(
      {
        intent,
        ranked: [],
        error: `route analysis failed: ${(e as Error).message ?? String(e)}`,
      },
      { status: 502 },
    );
  }

  if (routes.length === 0) {
    return NextResponse.json({
      intent,
      ranked: [],
      note: 'no routes found for this intent',
    });
  }

  // Step 3: AI ranking with reasoning
  const ranked = await rankRoutes({ intent, routes });

  // Serialize bigints since NextResponse JSON-encodes the body and bigint
  // throws by default.
  const safeRanked = ranked.map((r) => ({
    rank: r.rank,
    label: r.label,
    hops: r.hops,
    txCount: r.txCount,
    inputMint: r.inputMint,
    outputMint: r.outputMint,
    amountOut: r.amountOut.toString(),
    amountOutPretty: r.amountOutPretty,
    costLamports: r.costLamports,
    costPretty: r.costPretty,
    tipLamports: r.tipLamports,
    landingProb: r.landingProb,
    feeBps: r.feeBps,
    feeAmount: r.feeAmount.toString(),
    feePretty: r.feePretty,
    userReceives: r.userReceives.toString(),
    userReceivesPretty: r.userReceivesPretty,
    notes: r.notes ?? [],
    reasoning: r.reasoning,
  }));

  return NextResponse.json({
    intent,
    ranked: safeRanked,
    fee: { bps: CARDO_FEE_BPS, treasury: CARDO_TREASURY_PUBKEY },
    rpcCount: MAINNET_RPCS.length,
  });
}
