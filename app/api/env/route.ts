// Runtime env endpoint — the seam that lets ONE Cardo image run any chain.
//
// Next.js inlines `NEXT_PUBLIC_*` into the CLIENT bundle at BUILD time, which
// would tie the image to one chain. This route runs on the SERVER and reads
// `process.env` at REQUEST time, so the browser learns its chain + WalletConnect
// id from the container's env without a rebuild. Mirrors the Rome web app's
// /api/env + aerarium's. Set these on the container WITHOUT the `NEXT_PUBLIC_`
// prefix (a `NEXT_PUBLIC_` fallback is read too, for back-compat with the old
// per-chain build-arg images).

import { NextResponse } from 'next/server';
import { normalizeRuntimeEnv, DEFAULT_CHAIN_ID } from '@/lib/runtime-env';

export const dynamic = 'force-dynamic'; // never cache — runtime process.env reads

export function GET() {
  const rawChain =
    process.env.ROME_CHAIN_ID ?? process.env.NEXT_PUBLIC_ROME_CHAIN_ID ?? '';
  const chainId = rawChain ? Number(rawChain) : DEFAULT_CHAIN_ID;
  const walletConnectProjectId =
    process.env.WALLETCONNECT_PROJECT_ID ??
    process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ??
    '';

  const bridgeApiBase =
    process.env.BRIDGE_API_BASE ?? process.env.NEXT_PUBLIC_BRIDGE_API_BASE ?? '';

  const env = normalizeRuntimeEnv({ chainId, walletConnectProjectId, bridgeApiBase });
  return NextResponse.json(env, {
    headers: { 'cache-control': 'no-store, no-cache, must-revalidate' },
  });
}
