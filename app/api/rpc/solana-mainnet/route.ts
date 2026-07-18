// Same-origin RPC proxy for Solana mainnet.
//
// Sibling to /api/rpc/solana-devnet. Used for read-only mainnet integrations
// where the user's Rome PDA owns lamports + SPL token accounts on Solana
// mainnet (not devnet) — currently SPL stake-pool LSTs (JitoSOL et al,
// Family 1 of the integration roadmap).
//
// Same CORS reasoning as solana-devnet: route through Next.js so the
// browser fetch is same-origin.
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md

import { NextRequest, NextResponse } from 'next/server';

const UPSTREAM = 'https://api.mainnet-beta.solana.com';

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
