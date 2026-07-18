// Same-origin RPC proxy for Sepolia — the inbound-bridge source chain.
//
// The inbound hooks (use-inbound-cctp-send / use-inbound-wh-send) wait on the
// Sepolia burn/transfer receipt via wagmi's publicClient, which uses Cardo's
// configured Sepolia transport. Route those reads through Next.js so the
// browser fetch is same-origin (mirrors /api/rpc/rome). The user's WALLET signs
// the burn against its own Sepolia RPC; this proxy is only for Cardo's reads.
//
// Internal-RPC rule: SEPOLIA_RPC_URL env wins (point it at an internal endpoint
// in prod — no redeploy needed); default = the registry bridge.json Sepolia RPC.
// The registry carries no internal Sepolia endpoint today (endpoints.json={}).

import { NextRequest, NextResponse } from 'next/server';
import { getChainConfig, HADRIAN_CHAIN_ID } from '@/lib/chain-config';

const UPSTREAM =
  process.env.SEPOLIA_RPC_URL ??
  getChainConfig(HADRIAN_CHAIN_ID).bridge?.sourceEvm.rpcUrl ??
  'https://ethereum-sepolia-rpc.publicnode.com';

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
