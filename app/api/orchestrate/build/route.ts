// POST /api/orchestrate/build — return ONE UNSIGNED tx for client signing.
//
// Atomic-by-tx instead of atomic-by-bundle: Jupiter swap + Cardo fee land
// in a single versioned tx, both or neither — no Jito tip dependency.
//
// Why this design (rebuilt 2026-04-28 from a 4-tx Jito bundle):
//   - User must NEVER pay a Jito tip if their swap doesn't execute. Jito's
//     queue can include a bundle 5-60s after we've moved on, so any flow
//     that relies on a separate signed tip tx is exposed to that race.
//   - Combining swap + fee in one Solana tx gives atomicity at the
//     tx-level — Solana guarantees all-or-nothing per signature.
//   - Plain RPC submission (dedicated primary, public fallback) is fast and
//     leader-slot-independent. Confirms in 1-3s on healthy mainnet.
//   - Trade-off: no MEV/sandwich protection. Acceptable for Jupiter swaps
//     because Jupiter splits liquidity; sandwich requires a single-pool
//     target. We'll re-add Jito for arb / compose intents (where atomicity
//     across multiple txs matters) as an explicit "atomic mode" later.
//
// Sister endpoint to /api/orchestrate/submit:
//   - submit  → signs server-side with Cardo's orchestrator wallet (demo)
//   - build   → returns unsigned tx for the user's wallet to sign
//                (production mode — user retains custody)

import { NextRequest, NextResponse } from 'next/server';
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { jupSwapForBundle } from '@/lib/orchestration/jupiter';
import {
  CARDO_FEE_BPS,
  CARDO_TREASURY_PUBKEY,
  withRpcFailover,
} from '@/lib/orchestration/config';

export const runtime = 'nodejs';

const WSOL = 'So11111111111111111111111111111111111111112';

// Memo program: lets us tag every Cardo orchestrator tx so the activity
// panel can find them via getSignaturesForAddress + memo filter.
const MEMO_PROGRAM = new PublicKey(
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
);
function memoIx(memo: string): TransactionInstruction {
  return new TransactionInstruction({
    keys: [],
    programId: MEMO_PROGRAM,
    data: Buffer.from(memo, 'utf8'),
  });
}

type BuildBody = {
  intent: { kind: string; params: Record<string, unknown> };
  routeIndex?: number;
  inputMint?: string;
  outputMint?: string;
  amountInSol?: number;
  slippageBps?: number;
  /// User's Solana wallet pubkey (base58). Becomes the feePayer + only signer.
  userPubkey: string;
};

export async function POST(req: NextRequest) {
  let body: BuildBody;
  try {
    body = (await req.json()) as BuildBody;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  // swap and stake share the same execution path: route input mint →
  // output mint via Jupiter aggregation, take a SOL fee on input.
  // Stake routes return Jupiter aggregator paths to LST mints; some routes
  // pick the spl-stake-pool DepositSol directly when it's cheapest.
  if (!['swap', 'stake'].includes(body.intent?.kind ?? '')) {
    return NextResponse.json(
      {
        error: `build not yet wired for kind="${body.intent?.kind}". Supported: swap, stake.`,
      },
      { status: 501 },
    );
  }

  if (!body.userPubkey) {
    return NextResponse.json({ error: 'missing userPubkey' }, { status: 400 });
  }

  let user: PublicKey;
  try {
    user = new PublicKey(body.userPubkey);
  } catch {
    return NextResponse.json({ error: 'invalid userPubkey' }, { status: 400 });
  }

  const inputMint = body.inputMint ?? WSOL;
  const outputMint =
    body.outputMint ??
    (body.intent.params.outputMint as string | undefined) ??
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const amountInSol =
    body.amountInSol ??
    (body.intent.params.amountInSol as number | undefined) ??
    0.005;
  const slippageBps = body.slippageBps ?? 100;
  const amountInLamports = BigInt(Math.floor(amountInSol * 1e9));

  const treasury = new PublicKey(CARDO_TREASURY_PUBKEY);
  const feeLamports = BigInt(
    Math.floor((Number(amountInLamports) * CARDO_FEE_BPS) / 10_000),
  );

  // Jupiter quote + ix list. User is the swap account.
  let swap: Awaited<ReturnType<typeof jupSwapForBundle>>;
  try {
    swap = await withRpcFailover((conn) =>
      jupSwapForBundle({
        conn,
        inputMint,
        outputMint,
        amount: amountInLamports,
        slippageBps,
        user,
        wrapAndUnwrapSol: true,
      }),
    );
  } catch (e) {
    return NextResponse.json(
      { error: `jupiter quote/ix failed: ${(e as Error).message}` },
      { status: 502 },
    );
  }

  let blockhash: string;
  try {
    const bh = await withRpcFailover((conn) =>
      conn.getLatestBlockhash('confirmed'),
    );
    blockhash = bh.blockhash;
  } catch (e) {
    return NextResponse.json(
      { error: `getLatestBlockhash failed: ${(e as Error).message}` },
      { status: 502 },
    );
  }

  // Build ONE versioned tx that contains:
  //   - Jupiter's compute budget ixs (sized dynamically to the actual route)
  //   - Jupiter setup ixs (ATA creates if needed)
  //   - Jupiter swap ix
  //   - Jupiter cleanup ix (if any — typically WSOL unwrap)
  //   - Cardo fee transfer to treasury
  //
  // Compute budget comes from Jupiter (we pass dynamicComputeUnitLimit:true
  // + prioritizationFeeLamports:'auto' to their API). Setting CU to the
  // Solana 1.4M max ourselves caused Phantom's simulator to misreport
  // "not enough SOL" even on wallets with plenty of balance.
  //
  // Atomicity: Solana guarantees all-or-nothing per signed tx. If the swap
  // fails (slippage, no liquidity, etc.), the fee transfer also doesn't
  // execute — the user pays nothing beyond the ~5000 lamport network fee.
  // This is THE invariant: user pays only if their swap landed.
  // Memo identifies the tx as Cardo-orchestrator-produced so the
  // activity panel can find it. ASCII only — utf-8 arrows can confuse
  // some indexers' memo regex. Placed at the END so it doesn't sit
  // between Jupiter's compute-budget ixs and its setup ixs (which
  // expect to be adjacent for some routes).
  const memoText = `cardo:${body.intent.kind} ${inputMint.slice(0, 4)}-${outputMint.slice(0, 4)} ${amountInSol}sol`;

  const ixs = [
    ...swap.computeBudgetIxs,
    ...swap.setupIxs,
    swap.swapIx,
    ...(swap.cleanupIx ? [swap.cleanupIx] : []),
  ];
  if (feeLamports > 0n) {
    ixs.push(
      SystemProgram.transfer({
        fromPubkey: user,
        toPubkey: treasury,
        lamports: Number(feeLamports),
      }),
    );
  }
  ixs.push(memoIx(memoText));

  const messageV0 = new TransactionMessage({
    payerKey: user,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message(swap.alts);
  const tx = new VersionedTransaction(messageV0);

  // If the combined tx exceeds Solana's 1232-byte v0 limit, the build
  // fails before signing. Surface it clearly so the client doesn't
  // pop up a wallet for an un-broadcastable tx.
  const serialized = Buffer.from(tx.serialize());
  if (serialized.length > 1232) {
    return NextResponse.json(
      {
        error: `combined swap+fee tx is ${serialized.length} bytes — exceeds 1232 byte v0 limit. Try a different route or reduce slippage.`,
      },
      { status: 502 },
    );
  }

  // Pre-flight simulation. If the tx would fail on-chain (insufficient
  // SOL for ATA rent, slippage too tight, missing accounts, etc.) we
  // catch it HERE — before the user signs anything. Avoids the
  // "Phantom popup with confusing error → user signs → tx reverts"
  // failure mode.
  let simErr: string | null = null;
  let simLogs: string[] | null = null;
  let simUnitsConsumed: number | null = null;
  try {
    const simRes = await withRpcFailover((conn) =>
      conn.simulateTransaction(tx, {
        sigVerify: false,           // tx isn't signed yet
        replaceRecentBlockhash: true, // use freshest blockhash for sim
        commitment: 'confirmed',
      }),
    );
    if (simRes.value.err) {
      simErr =
        typeof simRes.value.err === 'string'
          ? simRes.value.err
          : JSON.stringify(simRes.value.err);
      simLogs = simRes.value.logs ?? null;
    }
    simUnitsConsumed = simRes.value.unitsConsumed ?? null;
  } catch (e) {
    // Sim is best-effort — if the RPC can't sim (rate-limited etc.)
    // we let the user proceed and surface any failure at submit time.
    // eslint-disable-next-line no-console
    console.warn('[build] simulateTransaction failed:', (e as Error).message);
  }

  if (simErr) {
    return NextResponse.json(
      {
        error: `pre-flight simulation failed: ${simErr}`,
        simLogs: simLogs?.slice(-15) ?? [],
      },
      { status: 422 },
    );
  }

  return NextResponse.json({
    tx: {
      kind: 'v0' as const,
      b64: serialized.toString('base64'),
    },
    blockhash,
    txSize: serialized.length,
    simUnitsConsumed,
    quote: {
      inAmount: swap.quote.inAmount,
      outAmount: swap.quote.outAmount,
      otherAmountThreshold: swap.quote.otherAmountThreshold,
      route: swap.quote.routePlan.map((s) => s.swapInfo.label).join(' → '),
    },
    fee: {
      bps: CARDO_FEE_BPS,
      lamports: feeLamports.toString(),
      treasury: CARDO_TREASURY_PUBKEY,
    },
    priorityFee: {
      strategy: 'jupiter-auto',
      computeUnitLimit: swap.computeUnitLimit ?? 200_000,
    },
  });
}
