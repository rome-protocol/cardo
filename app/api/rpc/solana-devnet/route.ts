// Same-origin RPC proxy for the Solana devnet cluster (where Rome's
// devnet chains, e.g. Hadrian, settle).
//
// Why this exists: routing through Next.js makes the browser fetch
// same-origin (CORS), and lets us point at Rome's OWN RPC rather than a
// public endpoint.
//
// Used by `useSolanaTokenBalances` to read SPL ATA balances directly,
// bypassing the WUSDC/WWSOL wrapper's user-registration requirement.
//
// UPSTREAM = Rome's internal devnet Solana RPC follower (registry
// service `solana-rpc-devnet-eu`). Hard rule: use Rome's own RPC, never
// the public/rate-limited `api.devnet.solana.com`. Override per-deploy
// with SOLANA_DEVNET_RPC. (Ideally sourced from the registry's per-chain
// `solanaRpcUrl` once that field is populated for the devnet chains.)

import { NextRequest, NextResponse } from 'next/server';

const UPSTREAM =
  process.env.SOLANA_DEVNET_RPC ??
  'https://api.devnet.solana.com/';

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
