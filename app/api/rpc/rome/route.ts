// Same-origin RPC proxy for the active Rome chain.
//
// Why this exists: Rome's upstream proxy doesn't emit CORS headers that
// wagmi/viem-compatible browser fetches reliably trust. Route through
// Next.js so the browser fetch is same-origin. Every page-side Rome read
// + every tx receipt poll (`eth_getTransactionReceipt`) goes through here
// (see lib/wagmi.ts `browserRpc`, and the receipt-poll fetches in
// use-dlmm-swap / use-mango / use-ata-init / use-wrap-gas / the swap +
// pool pages).
//
// Upstream is the active chain's RPC from the registry (Hadrian 200010 by
// default; Nerva 210000 via NEXT_PUBLIC_ROME_CHAIN_ID) — not hardcoded.
// `ROME_RPC_URL` env overrides for local pointing at a custom node.

import { NextRequest, NextResponse } from 'next/server';
import { activeChain } from '@/lib/chain-config';

const UPSTREAM = process.env.ROME_RPC_URL ?? activeChain().rpcUrl;

export async function POST(req: NextRequest) {
  const body = await req.text();

  const upstreamRes = await fetch(UPSTREAM, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    cache: 'no-store',
  });

  const text = await upstreamRes.text();
  return new NextResponse(text, {
    status: upstreamRes.status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  });
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
    },
  });
}
