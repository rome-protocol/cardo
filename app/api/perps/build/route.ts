// POST /api/perps/build — ONE unsigned tx for a Jupiter Perps
// request (open = createIncreasePositionMarketRequest, close =
// createDecreasePositionMarketRequest with entirePosition).
//
// Same contract as /api/orchestrate/build: server builds + pre-flight
// simulates, returns { tx, txSize, simUnitsConsumed, quote, fee } — the
// client signs with the user's wallet and relays. Atomicity invariant:
// escrow transfer + Cardo fee + memo ride the same tx, all-or-nothing.
// (The keeper fill itself happens seconds later on Jupiter's side; if a
// request ever expires unexecuted, Jupiter refunds via closePositionRequest.)
//
// Collateral UX: everything is funded in USDC. Shorts natively collateralize
// USDC; longs collateralize the traded token, so the request carries
// jupiterMinimumOut and the keeper performs the USDC→token swap at fill
// time (Jupiter UI's own pattern).
//
// Builders + PDA schemas are live-verified — see lib/jupiter-perps.ts and the
// mainnet round-trip in tests/jupiter-perps.test.ts's header ($12 SOL short
// opened+closed, 2026-07-07).

import { NextRequest, NextResponse } from 'next/server';
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  buildIncreasePositionMarketRequestIx,
  buildDecreasePositionMarketRequestIx,
  JUP_PERPS_CUSTODIES,
  Side,
  type PerpMarketSymbol,
} from '@/lib/jupiter-perps';
import { jupQuote } from '@/lib/orchestration/jupiter';
import {
  CARDO_FEE_BPS,
  CARDO_TREASURY_PUBKEY,
  withRpcFailover,
} from '@/lib/orchestration/config';

export const runtime = 'nodejs';

const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const memoIx = (memo: string) =>
  new TransactionInstruction({ keys: [], programId: MEMO_PROGRAM, data: Buffer.from(memo, 'utf8') });

type BuildPerpBody = {
  intent: { kind: string; params: Record<string, unknown> };
  userPubkey: string;
};

export async function POST(req: NextRequest) {
  let body: BuildPerpBody;
  try {
    body = (await req.json()) as BuildPerpBody;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  if (body.intent?.kind !== 'perp') {
    return NextResponse.json({ error: 'build-perp only handles kind="perp"' }, { status: 400 });
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

  const p = body.intent.params;
  const market = ((['SOL', 'ETH', 'BTC'] as const).find(
    (m) => m === String(p.market ?? 'SOL').toUpperCase(),
  ) ?? 'SOL') as PerpMarketSymbol;
  const side = String(p.side ?? 'long') === 'short' ? Side.Short : Side.Long;
  const action = String(p.action ?? 'open') === 'close' ? 'close' : 'open';
  const leverage = Math.min(Math.max(Number(p.leverage ?? 3) || 3, 1.1), 100);
  const sizeUsd = Math.max(Number(p.sizeUsd ?? 12) || 12, 10);
  const collateralUsd = Number(p.collateralUsd ?? 0) || sizeUsd / leverage;
  const cust = JUP_PERPS_CUSTODIES[market];
  const usdcMint = JUP_PERPS_CUSTODIES.USDC.mint;

  // Live mark for slippage rails (±5% entry rail; ±40% close rail so an
  // entire-position close can't get stuck behind a moving market).
  let markUsd: number;
  try {
    const probe = BigInt(10) ** BigInt(cust.decimals - 2);
    const q = await jupQuote({
      inputMint: cust.mint.toBase58(),
      outputMint: usdcMint.toBase58(),
      amount: probe,
      slippageBps: 100,
    });
    markUsd = Number(q.outAmount) / 1e6 / (Number(probe) / 10 ** cust.decimals);
  } catch (e) {
    return NextResponse.json(
      { error: `mark-price quote failed: ${(e as Error).message}` },
      { status: 502 },
    );
  }

  const counter = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
  const usd6 = (n: number) => BigInt(Math.round(n * 1e6));
  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
  ];

  let feeLamports = 0n;
  let memoText: string;
  if (action === 'open') {
    // Longs are funded in USDC too: the keeper swaps USDC → the collateral
    // token at fill time; jupiterMinimumOut guards that swap.
    let jupiterMinimumOut: bigint | undefined;
    if (side === Side.Long) {
      const outFloat = (collateralUsd / markUsd) * 0.98; // 2% swap guard
      jupiterMinimumOut = BigInt(Math.floor(outFloat * 10 ** cust.decimals));
    }
    const priceSlippage =
      side === Side.Long ? usd6(markUsd * 1.05) : usd6(markUsd * 0.95);
    ixs.push(
      buildIncreasePositionMarketRequestIx({
        owner: user,
        market,
        side,
        sizeUsdDelta: usd6(sizeUsd),
        collateralTokenDelta: usd6(collateralUsd), // USDC input, 6dp
        priceSlippage,
        counter,
        inputMint: usdcMint,
        jupiterMinimumOut,
      }),
    );
    // Cardo take-rate on the collateral, paid in SOL lamports (same tx —
    // fee lands only if the escrow does).
    const feeUsd = (collateralUsd * CARDO_FEE_BPS) / 10_000;
    const solPriceProbe = market === 'SOL' ? markUsd : null;
    let solUsd = solPriceProbe;
    if (solUsd === null) {
      try {
        const q = await jupQuote({
          inputMint: JUP_PERPS_CUSTODIES.SOL.mint.toBase58(),
          outputMint: usdcMint.toBase58(),
          amount: 10_000_000n, // 0.01 SOL
          slippageBps: 100,
        });
        solUsd = Number(q.outAmount) / 1e6 / 0.01;
      } catch {
        solUsd = 200; // conservative fallback only for fee sizing
      }
    }
    feeLamports = BigInt(Math.floor((feeUsd / solUsd) * 1e9));
    memoText = `cardo:perp ${market} ${side === Side.Long ? 'long' : 'short'} $${sizeUsd} ${leverage}x`;
  } else {
    const priceSlippage =
      side === Side.Long ? usd6(markUsd * 0.6) : usd6(markUsd * 1.4);
    ixs.push(
      buildDecreasePositionMarketRequestIx({
        owner: user,
        market,
        side,
        entirePosition: true,
        priceSlippage,
        counter,
        desiredMint: usdcMint,
      }),
    );
    memoText = `cardo:perp ${market} close-${side === Side.Long ? 'long' : 'short'}`;
  }

  if (feeLamports > 0n) {
    ixs.push(
      SystemProgram.transfer({
        fromPubkey: user,
        toPubkey: new PublicKey(CARDO_TREASURY_PUBKEY),
        lamports: Number(feeLamports),
      }),
    );
  }
  ixs.push(memoIx(memoText));

  let blockhash: string;
  try {
    blockhash = (await withRpcFailover((conn) => conn.getLatestBlockhash('confirmed'))).blockhash;
  } catch (e) {
    return NextResponse.json(
      { error: `getLatestBlockhash failed: ${(e as Error).message}` },
      { status: 502 },
    );
  }

  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: user,
      recentBlockhash: blockhash,
      instructions: ixs,
    }).compileToV0Message(),
  );
  const serialized = Buffer.from(tx.serialize());
  if (serialized.length > 1232) {
    return NextResponse.json(
      { error: `perp tx is ${serialized.length} bytes — exceeds the 1232-byte v0 limit` },
      { status: 502 },
    );
  }

  // Pre-flight sim — catches missing USDC ATA / balance, bad position PDA
  // (e.g. closing a position that doesn't exist) before any wallet popup.
  let simErr: string | null = null;
  let simLogs: string[] | null = null;
  let simUnitsConsumed: number | null = null;
  try {
    const simRes = await withRpcFailover((conn) =>
      conn.simulateTransaction(tx, {
        sigVerify: false,
        replaceRecentBlockhash: true,
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
    // eslint-disable-next-line no-console
    console.warn('[build-perp] simulateTransaction failed:', (e as Error).message);
  }
  if (simErr) {
    return NextResponse.json(
      { error: `pre-flight simulation failed: ${simErr}`, simLogs: simLogs?.slice(-15) ?? [] },
      { status: 422 },
    );
  }

  return NextResponse.json({
    tx: { kind: 'v0' as const, b64: serialized.toString('base64') },
    blockhash,
    txSize: serialized.length,
    simUnitsConsumed,
    quote: {
      inAmount: usd6(action === 'open' ? collateralUsd : 0).toString(),
      outAmount: usd6(sizeUsd).toString(),
      otherAmountThreshold: '0',
      route:
        action === 'open'
          ? `Jupiter Perps · ${market} ${side === Side.Long ? 'long' : 'short'} ${leverage}x @ ~$${markUsd.toFixed(2)}`
          : `Jupiter Perps · close ${market} ${side === Side.Long ? 'long' : 'short'}`,
    },
    fee: {
      bps: action === 'open' ? CARDO_FEE_BPS : 0,
      lamports: feeLamports.toString(),
      treasury: CARDO_TREASURY_PUBKEY,
    },
    perp: { market, side: side === Side.Long ? 'long' : 'short', action, sizeUsd, collateralUsd, leverage, markUsd },
  });
}
