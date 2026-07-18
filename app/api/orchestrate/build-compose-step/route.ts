// POST /api/orchestrate/build-compose-step — build ONE step of a compose intent.
//
// Compose execute is sequential: step 0 → wait for confirm → step 1 → ...
// Between steps, the server reads the user's actual on-chain balance of
// the intermediate token so step N+1's amountIn reflects the real output
// of step N (not the AI's pre-execute estimate, which can be off by 1-2%
// due to slippage).
//
// Body: {
//   intent: { kind: 'compose', params: { steps: [...] }, ... },
//   stepIndex: 0-based index of the step to build,
//   userPubkey: base58,
//   slippageBps?: number,
// }
//
// Response: {
//   tx: { kind, b64 } — unsigned tx for the user to sign,
//   label, description, isLast: boolean,
// }
// or { error } on the next-step path being unsupported.
//
// Supported leaf kinds for v0: swap, stake. Yield is wired but routes
// through the existing build-yield (which itself returns 1-2 sub-steps,
// further nested-stepping; for v0 we say "compose with yield" requires
// the user to run yield separately first if Kamino setup is missing).
// arb is not yet supported as a leaf.

import { NextRequest, NextResponse } from 'next/server';
import { Connection, PublicKey } from '@solana/web3.js';
import { withRpcFailover } from '@/lib/orchestration/config';

export const runtime = 'nodejs';

type ComposeStep = {
  kind: 'swap' | 'stake' | 'yield' | 'arb';
  params: Record<string, unknown>;
  summary?: string;
};

type Body = {
  intent: { kind: string; params: Record<string, unknown> };
  stepIndex: number;
  userPubkey: string;
  slippageBps?: number;
};

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

function ataFor(mint: PublicKey, owner: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM,
  );
  return ata;
}

/// Read user's actual balance of an SPL token (or SOL).
/// Returns: raw smallest units OR null if account doesn't exist yet.
async function readUserBalance(
  conn: Connection,
  user: PublicKey,
  mintBase58: string,
): Promise<bigint | null> {
  // SOL — read native lamports
  if (mintBase58 === 'So11111111111111111111111111111111111111112') {
    const lamports = await conn.getBalance(user, 'confirmed');
    return BigInt(lamports);
  }
  const mint = new PublicKey(mintBase58);
  const ata = ataFor(mint, user);
  const acct = await conn.getAccountInfo(ata, 'confirmed');
  if (!acct) return null;
  if (acct.data.length < 72) return null;
  // SPL Token Account amount is u64 LE at offset 64
  return acct.data.readBigUInt64LE(64);
}

/// Adjust the step's amount-in to reflect the user's ACTUAL on-chain
/// balance of the input token. Leaves a 1% buffer to handle floating-
/// point-style edge cases (Solana token math is integer but slippage
/// quote estimates aren't always exact).
async function reconcileAmountIn(
  step: ComposeStep,
  user: PublicKey,
  intentParams: Record<string, unknown>,
): Promise<ComposeStep> {
  // Bump down 1% to leave headroom for any tx-fee dust or rounding
  const safeMargin = 99n;
  const safeDenom = 100n;

  if (step.kind === 'swap') {
    const inputMint = (step.params.inputMint as string) ?? 'So11111111111111111111111111111111111111112';
    const balance = await withRpcFailover((conn) =>
      readUserBalance(conn, user, inputMint),
    );
    if (balance === null) {
      // ATA doesn't exist; user has 0 of this token. Bail.
      throw new Error(
        `compose step needs ${inputMint.slice(0, 8)}… but your balance is 0. The previous step may not have produced any output.`,
      );
    }
    const adjusted = (balance * safeMargin) / safeDenom;
    if (inputMint === 'So11111111111111111111111111111111111111112') {
      // SOL: leave at least 0.005 SOL for fees + rent
      const min = 5_000_000n;
      if (adjusted < min) {
        throw new Error(
          `not enough SOL after previous step (need at least 0.005 SOL buffer)`,
        );
      }
      return {
        ...step,
        params: { ...step.params, amountInSol: Number(adjusted) / 1e9 },
      };
    }
    // SPL token: just pass adjusted raw
    return {
      ...step,
      params: { ...step.params, amountInRaw: adjusted.toString() },
    };
  }

  if (step.kind === 'stake') {
    const balance = await withRpcFailover((conn) =>
      readUserBalance(
        conn,
        user,
        'So11111111111111111111111111111111111111112',
      ),
    );
    if (!balance || balance < 6_000_000n) {
      throw new Error(`not enough SOL for stake step`);
    }
    const adjusted = (balance * safeMargin) / safeDenom - 5_000_000n;
    return {
      ...step,
      params: { ...step.params, amountInSol: Number(adjusted) / 1e9 },
    };
  }

  if (step.kind === 'yield') {
    // Default to USDC as the yield input (Kamino USDC reserve is the
    // only wired yield destination today).
    const usdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const balance = await withRpcFailover((conn) =>
      readUserBalance(conn, user, usdcMint),
    );
    if (!balance) {
      throw new Error(
        `compose yield step requires a USDC balance — previous step may not have produced any USDC`,
      );
    }
    const adjusted = (balance * safeMargin) / safeDenom;
    return {
      ...step,
      params: { ...step.params, amountInUsdc: Number(adjusted) / 1e6 },
    };
  }

  // arb / unknown — unchanged, AI's estimate is what we got
  void intentParams;
  return step;
}

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  if (body.intent?.kind !== 'compose') {
    return NextResponse.json(
      { error: `build-compose-step requires kind=compose; got "${body.intent?.kind}"` },
      { status: 400 },
    );
  }
  const steps = (body.intent.params.steps as ComposeStep[] | undefined) ?? [];
  if (!Array.isArray(steps) || steps.length === 0) {
    return NextResponse.json(
      { error: 'compose intent has no steps' },
      { status: 400 },
    );
  }
  if (
    body.stepIndex == null ||
    body.stepIndex < 0 ||
    body.stepIndex >= steps.length
  ) {
    return NextResponse.json(
      { error: `stepIndex out of range (have ${steps.length} steps)` },
      { status: 400 },
    );
  }

  let user: PublicKey;
  try {
    user = new PublicKey(body.userPubkey);
  } catch {
    return NextResponse.json({ error: 'invalid userPubkey' }, { status: 400 });
  }

  const step = steps[body.stepIndex];
  const isFirst = body.stepIndex === 0;
  const isLast = body.stepIndex === steps.length - 1;

  // For step 0, use the AI's params verbatim. For later steps, reconcile
  // amountIn against the user's actual on-chain balance of the input
  // token (output of the previous step).
  let resolvedStep: ComposeStep;
  try {
    resolvedStep = isFirst
      ? step
      : await reconcileAmountIn(step, user, body.intent.params);
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 422 },
    );
  }

  // Dispatch to the leaf-intent builder. Each leaf builder accepts a
  // single-intent shape, so we wrap the resolved step's params in an
  // intent-shaped object and forward.
  const baseHost =
    new URL(req.url).origin || 'http://localhost:3030';
  let leafEndpoint: string;
  let leafBody: Record<string, unknown>;

  if (resolvedStep.kind === 'swap' || resolvedStep.kind === 'stake') {
    leafEndpoint = `${baseHost}/api/orchestrate/build`;
    leafBody = {
      intent: { kind: resolvedStep.kind, params: resolvedStep.params },
      userPubkey: body.userPubkey,
      inputMint: resolvedStep.params.inputMint,
      outputMint: resolvedStep.params.outputMint,
      amountInSol: resolvedStep.params.amountInSol,
      slippageBps: body.slippageBps ?? 50,
    };
  } else if (resolvedStep.kind === 'yield') {
    leafEndpoint = `${baseHost}/api/orchestrate/build-yield`;
    leafBody = {
      intent: { kind: 'yield', params: resolvedStep.params },
      userPubkey: body.userPubkey,
      amountInUsdc: resolvedStep.params.amountInUsdc,
    };
  } else {
    return NextResponse.json(
      {
        error: `compose leaf kind "${resolvedStep.kind}" not supported in v0 (have: swap, stake, yield)`,
      },
      { status: 501 },
    );
  }

  const leafRes = await fetch(leafEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(leafBody),
  });
  const leaf = await leafRes.json();
  if (!leafRes.ok) {
    return NextResponse.json(
      {
        error: `step ${body.stepIndex + 1} build failed: ${leaf.error ?? leafRes.status}`,
        leafError: leaf,
      },
      { status: leafRes.status },
    );
  }

  // Both leaf endpoints normalize to a `txs[]` here so the client's
  // compose loop can iterate uniformly:
  //   - build (swap, stake)         → { tx: {kind, b64} }    → wrap as [tx]
  //   - build-yield (Kamino)        → { steps: [...] }       → 1 OR 2 entries
  //
  // The 2-entry yield case is "first-time Kamino setup needed":
  //   sub-tx 0 = init_user_metadata + init_obligation + init_obligation_farms
  //   sub-tx 1 = refresh_reserve + refresh_obligation + deposit_v2 + Cardo fee
  // Client signs each sub-tx in sequence; if sub-tx 0 lands and sub-tx 1
  // reverts, user has paid setup rent (~0.003 SOL, recoverable on close)
  // but no Cardo fee per the invariant — fee only charges on the deposit
  // sub-tx, which is atomic with the actual position.
  let txs: Array<{ kind: 'legacy' | 'v0'; b64: string; subLabel?: string }>;
  if (resolvedStep.kind === 'yield') {
    const innerSteps = leaf.steps as Array<{
      kind: 'legacy' | 'v0';
      b64: string;
      label?: string;
    }>;
    txs = innerSteps.map((s) => ({
      kind: s.kind,
      b64: s.b64,
      subLabel: s.label,
    }));
  } else {
    txs = [{ kind: leaf.tx.kind, b64: leaf.tx.b64 }];
  }

  return NextResponse.json({
    txs,
    label: step.summary ?? `Step ${body.stepIndex + 1}`,
    description: step.summary ?? `${resolvedStep.kind} step`,
    stepIndex: body.stepIndex,
    isLast,
    nestedSteps: txs.length,
    quote: leaf.quote,
    fee: leaf.fee,
    resolvedAmount: resolvedStep.params,
  });
}
