// POST /api/orchestrate/relay — submit a SIGNED single tx via Solana RPC.
//
// Receives the user-signed combined-swap-fee versioned tx from /build,
// broadcasts via sendRawTransaction, waits for confirmation. Returns
// { status, txSig, txUrl } on success.
//
// **The product invariant**: user pays only if their swap landed.
// Solana tx-level atomicity gives us this for free — if the tx fails
// at any instruction (slippage, sim error, blockhash expired), the
// whole thing rolls back. The user's only cost on failure is the
// ~5000-lamport (~$0.001) network fee for the tx attempt itself.
//
// No Jito, no bundle complexity. The MEV/atomicity-across-multiple-txs
// case (arb / compose) gets a separate "atomic mode" later.

import { NextRequest, NextResponse } from 'next/server';
import { Transaction, VersionedTransaction } from '@solana/web3.js';
import bs58Mod from 'bs58';
import { withRpcFailover } from '@/lib/orchestration/config';

const b58 = (bs58Mod as { default?: typeof bs58Mod }).default ?? bs58Mod;

export const runtime = 'nodejs';

type RelayBody = {
  tx?: { kind: 'legacy' | 'v0'; b64: string };
};

export async function POST(req: NextRequest) {
  let body: RelayBody;
  try {
    body = (await req.json()) as RelayBody;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  if (!body.tx?.b64) {
    return NextResponse.json(
      { error: 'missing tx (signed, base64)' },
      { status: 400 },
    );
  }

  const buf = Buffer.from(body.tx.b64, 'base64');
  const tx =
    body.tx.kind === 'v0'
      ? VersionedTransaction.deserialize(buf)
      : Transaction.from(buf);
  const sig = b58.encode(
    tx instanceof VersionedTransaction
      ? tx.signatures[0]
      : ((tx as Transaction).signature ?? Buffer.alloc(0)),
  );

  const t0 = Date.now();
  let landedSig: string;
  try {
    landedSig = await withRpcFailover((conn) =>
      conn.sendRawTransaction(buf, {
        skipPreflight: false,
        maxRetries: 3,
      }),
    );
  } catch (e) {
    return NextResponse.json(
      {
        error: `sendRawTransaction failed: ${(e as Error).message}`,
        txSig: sig,
      },
      { status: 502 },
    );
  }

  // Wait for confirmation. If the tx fails on chain (e.g., slippage),
  // confirmTransaction returns successfully but with err in the meta.
  // Re-check via getSignatureStatuses to surface that.
  try {
    await withRpcFailover((conn) =>
      conn.confirmTransaction(landedSig, 'confirmed'),
    );
  } catch (e) {
    return NextResponse.json(
      {
        error: `tx submitted but confirmTransaction failed: ${(e as Error).message}`,
        txSig: landedSig,
        txUrl: `https://solscan.io/tx/${landedSig}`,
      },
      { status: 502 },
    );
  }

  // Final status check — confirmTransaction can succeed for a tx that
  // landed-but-erred. Pull the actual on-chain meta.
  let onChainErr: unknown = null;
  try {
    const stat = await withRpcFailover((conn) =>
      conn.getSignatureStatuses([landedSig]),
    );
    onChainErr = stat.value[0]?.err ?? null;
  } catch {
    // Status check is best-effort; if it fails the tx still landed
    // somewhere (confirmTransaction just succeeded).
  }

  const elapsedMs = Date.now() - t0;

  if (onChainErr) {
    return NextResponse.json(
      {
        error: `tx landed but reverted on-chain: ${JSON.stringify(onChainErr)}`,
        status: 'Failed',
        txSig: landedSig,
        txUrl: `https://solscan.io/tx/${landedSig}`,
        elapsedMs,
      },
      { status: 200 }, // not an HTTP error — tx landed, just unsuccessfully
    );
  }

  return NextResponse.json({
    status: 'Confirmed',
    atomic: true,
    txSig: landedSig,
    txUrl: `https://solscan.io/tx/${landedSig}`,
    elapsedMs,
  });
}
