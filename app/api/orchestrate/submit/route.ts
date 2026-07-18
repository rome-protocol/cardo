// POST /api/orchestrate/submit — execute a chosen Route as a Jito bundle.
//
// Bundle shape (4-tx):
//   tx1  tip + start memo
//   tx2  Jupiter swap (versioned tx with ALT) — wraps SOL, swaps, unwraps
//   tx3  Cardo fee transfer to treasury (SystemProgram.transfer)
//   tx4  done memo
//
// Ownership notes for v0:
//   - Signer is Cardo's orchestrator wallet (demo mode). When users
//     connect their own wallets, this becomes user-signed and Cardo
//     just builds the unsigned bundle for them to sign client-side.
//   - Fee is taken in SOL (30 bps of input SOL) — simpler than Jupiter
//     platformFee since no treasury USDC ATA is required day-one.
//
// Only swap intents are supported in this surface; other kinds return
// 501 with a "coming soon" note.

import fs from 'node:fs';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58Mod from 'bs58';
import { jupSwapForBundle } from '@/lib/orchestration/jupiter';
import { submitBundle } from '@/lib/orchestration/submit';
import {
  CARDO_FEE_BPS,
  CARDO_TREASURY_PUBKEY,
  withRpcFailover,
  MAINNET_RPCS,
} from '@/lib/orchestration/config';

const b58 = (bs58Mod as { default?: typeof bs58Mod }).default ?? bs58Mod;

export const runtime = 'nodejs';

const JITO_ENDPOINTS = [
  'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles',
];

// Calibrated-to-land tip — see PLAYBOOK.md "Empirical landing rates".
// 3M lamports = $0.60 at $200/SOL = guaranteed land for ≤5-tx bundles.
const TIP_LAMPORTS = 3_000_000;

const HARDCODED_TIPS = [
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
];

const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
function memoIx(memo: string) {
  return {
    keys: [],
    programId: MEMO_PROGRAM,
    data: Buffer.from(memo, 'utf8'),
  };
}

const WSOL = 'So11111111111111111111111111111111111111112';

/// Path to Cardo's orchestrator wallet. Demo mode uses this signer; real
/// users would connect their own wallet and sign client-side.
const KEY_PATH = path.join(
  process.env.HOME ?? '',
  'rome/.secrets/cardo-mainnet/orchestrator-v1.key',
);

function loadOrchestratorWallet(): Keypair {
  const bytes = JSON.parse(fs.readFileSync(KEY_PATH).toString());
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

type SubmitBody = {
  intent: { kind: string; params: Record<string, unknown> };
  routeIndex?: number; // chosen rank (advisory only — we execute via Jupiter)
  inputMint?: string;
  outputMint?: string;
  amountInSol?: number;
  slippageBps?: number;
};

export async function POST(req: NextRequest) {
  // Demo mode (server signs + pays from Cardo's own wallet) is OFF unless
  // explicitly enabled. The pod never carries `orchestrator-v1.key`, so this
  // path used to ENOENT and 500. Real users connect their own Solana wallet
  // and sign client-side (the /build → sign → /relay path); this endpoint is a
  // local-dev-only convenience, gated behind CARDO_DEMO_MODE.
  if (process.env.CARDO_DEMO_MODE !== '1') {
    return NextResponse.json(
      { error: 'Demo mode is disabled — connect a Solana wallet to execute.' },
      { status: 501 },
    );
  }

  let body: SubmitBody;
  try {
    body = (await req.json()) as SubmitBody;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  if (body.intent?.kind !== 'swap') {
    return NextResponse.json(
      {
        error: `submit not yet wired for kind="${body.intent?.kind}". Only "swap" is supported in this v0 surface.`,
      },
      { status: 501 },
    );
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

  let payer: Keypair;
  try {
    payer = loadOrchestratorWallet();
  } catch (e) {
    return NextResponse.json(
      {
        error: `orchestrator wallet missing at ${KEY_PATH}: ${(e as Error).message}`,
      },
      { status: 500 },
    );
  }

  const treasury = new PublicKey(CARDO_TREASURY_PUBKEY);

  // Fee in SOL: 30 bps of input. Trivial absolute amount per swap; scales
  // with trade size which is the take-rate model.
  const feeLamports = BigInt(
    Math.floor(Number(amountInLamports) * CARDO_FEE_BPS / 10_000),
  );

  const t0 = Date.now();

  // Build Jupiter swap instructions against a failover-aware Connection.
  let swap: Awaited<ReturnType<typeof jupSwapForBundle>>;
  try {
    swap = await withRpcFailover((conn) =>
      jupSwapForBundle({
        conn,
        inputMint,
        outputMint,
        amount: amountInLamports,
        slippageBps,
        user: payer.publicKey,
        wrapAndUnwrapSol: true,
      }),
    );
  } catch (e) {
    return NextResponse.json(
      { error: `jupiter quote/ix failed: ${(e as Error).message}` },
      { status: 502 },
    );
  }

  const tipAccount = new PublicKey(
    HARDCODED_TIPS[Math.floor(Math.random() * HARDCODED_TIPS.length)],
  );

  // Try each Jito endpoint in turn (matches demo-mainnet-jupiter.ts pattern).
  let result: Awaited<ReturnType<typeof submitBundle>> | null = null;
  let landingTxs: (Transaction | VersionedTransaction)[] | null = null;
  let lastErr: string | null = null;

  for (const ep of JITO_ENDPOINTS) {
    let blockhash: string;
    try {
      const bh = await withRpcFailover((conn) =>
        conn.getLatestBlockhash('confirmed'),
      );
      blockhash = bh.blockhash;
    } catch (e) {
      lastErr = `getLatestBlockhash failed: ${(e as Error).message}`;
      continue;
    }

    // tx1 — tip + start memo (legacy)
    const tx1 = new Transaction({
      recentBlockhash: blockhash,
      feePayer: payer.publicKey,
    });
    tx1.add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: tipAccount,
        lamports: TIP_LAMPORTS,
      }),
      memoIx(
        `cardo:orchestrator swap ${inputMint.slice(0, 4)}→${outputMint.slice(
          0,
          4,
        )} ${amountInSol}sol`,
      ),
    );
    tx1.sign(payer);

    // tx2 — Jupiter setup + swap + cleanup, all in one versioned tx with ALT.
    const allJupIxs = [
      ...swap.setupIxs,
      swap.swapIx,
      ...(swap.cleanupIx ? [swap.cleanupIx] : []),
    ];
    const messageV0 = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: allJupIxs,
    }).compileToV0Message(swap.alts);
    const tx2 = new VersionedTransaction(messageV0);
    tx2.sign([payer]);

    // tx3 — Cardo fee transfer to treasury (legacy). Skip if feeLamports==0.
    const txs: (Transaction | VersionedTransaction)[] = [tx1, tx2];
    if (feeLamports > 0n) {
      const tx3 = new Transaction({
        recentBlockhash: blockhash,
        feePayer: payer.publicKey,
      });
      tx3.add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: treasury,
          lamports: Number(feeLamports),
        }),
        memoIx(`cardo:fee ${CARDO_FEE_BPS}bps`),
      );
      tx3.sign(payer);
      txs.push(tx3);
    }

    // txN — done memo (legacy)
    const txDone = new Transaction({
      recentBlockhash: blockhash,
      feePayer: payer.publicKey,
    });
    txDone.add(memoIx(`cardo:swap done`));
    txDone.sign(payer);
    txs.push(txDone);

    try {
      result = await submitBundle({
        txs,
        blockEngineUrl: ep,
        solanaRpcUrl: MAINNET_RPCS[0],
        pollTimeoutMs: 30_000,
        pollIntervalMs: 2_000,
      });
      if (result.status === 'Confirmed' || result.status === 'Failed') {
        landingTxs = txs;
        break;
      }
      // Pending / Timeout → try next endpoint
    } catch (e) {
      lastErr = (e as Error).message ?? String(e);
    }
  }

  if (!result || !landingTxs) {
    return NextResponse.json(
      {
        error: `all Jito endpoints failed: ${lastErr ?? 'unknown'}`,
      },
      { status: 502 },
    );
  }

  // Extract sigs (legacy → tx.signature; versioned → signatures[0]).
  const sigs = landingTxs.map((tx) => {
    if (tx instanceof VersionedTransaction) return b58.encode(tx.signatures[0]);
    const sig = (tx as Transaction).signature ?? Buffer.alloc(0);
    return b58.encode(sig);
  });

  const elapsedMs = Date.now() - t0;

  return NextResponse.json({
    status: result.status,
    bundleId: result.bundleId,
    bundleUrl: `https://explorer.jito.wtf/bundle/${result.bundleId}`,
    txSigs: sigs,
    txUrls: sigs.map((s) => `https://solscan.io/tx/${s}`),
    quote: {
      inAmount: swap.quote.inAmount,
      outAmount: swap.quote.outAmount,
      otherAmountThreshold: swap.quote.otherAmountThreshold,
      route: swap.quote.routePlan.map((s) => s.swapInfo.label).join(' → '),
    },
    fee: { bps: CARDO_FEE_BPS, lamports: feeLamports.toString(), treasury: CARDO_TREASURY_PUBKEY },
    tip: { lamports: TIP_LAMPORTS, account: tipAccount.toBase58() },
    elapsedMs,
    err: result.err ?? null,
  });
}
