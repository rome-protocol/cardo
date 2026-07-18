// GET /api/orchestrate/activity?wallet=<base58>
//
// Returns the connected wallet's recent Cardo orchestrator activity.
// Filter is the "cardo:" memo prefix we attach to every orchestrator tx.
// We pull the last ~30 sigs for the wallet and inspect each tx's memo
// instructions; only those tagged with "cardo:" are returned.
//
// Why memo-based: every orchestrator tx (single-atomic or multi-tx
// bundle) carries a SystemMemo with the "cardo:" prefix, so we can
// identify ours without per-program decoding. Cheaper than parsing
// program calls.

import { NextRequest, NextResponse } from 'next/server';
import { PublicKey } from '@solana/web3.js';
import { withRpcFailover } from '@/lib/orchestration/config';

export const runtime = 'nodejs';

const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

type ActivityEntry = {
  sig: string;
  blockTime: number | null;
  slot: number;
  status: 'Confirmed' | 'Failed' | 'Processed';
  cardoMemo: string;
  txUrl: string;
};

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get('wallet');
  const limit = parseInt(req.nextUrl.searchParams.get('limit') ?? '10', 10);

  if (!wallet) {
    return NextResponse.json({ error: 'missing wallet' }, { status: 400 });
  }
  let pubkey: PublicKey;
  try {
    pubkey = new PublicKey(wallet);
  } catch {
    return NextResponse.json({ error: 'invalid wallet pubkey' }, { status: 400 });
  }

  // Pull recent signatures (we scan ~30 to find ~10 Cardo ones — most
  // wallets will have non-Cardo activity mixed in).
  type Sig = { signature: string; blockTime?: number | null; slot: number; err: unknown };
  let sigs: Sig[];
  try {
    sigs = (await withRpcFailover((conn) =>
      conn.getSignaturesForAddress(pubkey, { limit: 30 }),
    )) as Sig[];
  } catch (e) {
    return NextResponse.json(
      { error: `getSignaturesForAddress failed: ${(e as Error).message}` },
      { status: 502 },
    );
  }

  // Fetch each tx in parallel and filter for cardo: memo.
  // We cap concurrency by just doing all 30 in parallel — the RPC tier
  // handles this fine.
  const txs = await Promise.all(
    sigs.map(async (s) => {
      try {
        const tx = await withRpcFailover((conn) =>
          conn.getTransaction(s.signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          }),
        );
        if (!tx) return null;

        // Find memo program invocations with cardo: prefix
        const memoLogs = (tx.meta?.logMessages ?? []).filter((l) =>
          l.startsWith('Program log: Memo'),
        );
        const cardoMemo = memoLogs
          .map((l) => {
            // Format: 'Program log: Memo (len N): "cardo:..."'
            const m = l.match(/"([^"]+)"/);
            return m?.[1] ?? '';
          })
          .find((s) => s.startsWith('cardo:'));

        if (!cardoMemo) return null;

        const status: ActivityEntry['status'] = s.err
          ? 'Failed'
          : 'Confirmed';

        return {
          sig: s.signature,
          blockTime: s.blockTime ?? null,
          slot: s.slot,
          status,
          cardoMemo,
          txUrl: `https://solscan.io/tx/${s.signature}`,
        } satisfies ActivityEntry;
      } catch {
        return null;
      }
    }),
  );

  const activity = txs
    .filter((x) => x !== null)
    .slice(0, limit);

  return NextResponse.json({ wallet, activity });
}
