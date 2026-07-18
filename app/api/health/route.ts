// Liveness probe for the deploy tooling.
//
// The ops `rome_cardo` role wires this to both the container healthcheck
// (docker-compose) and the post-deploy nginx smoke (`GET /api/health` must
// return 200 with `{ ok: true }`). Keep it dependency-free — it must answer
// even when an upstream RPC is down, so it asserts the Next.js server is up,
// nothing more. Reports the build-pinned active chain for at-a-glance triage.

import { NextResponse } from 'next/server';
import { activeChain } from '@/lib/chain-config';

// Never cache — the probe must reflect live process state.
export const dynamic = 'force-dynamic';

export function GET() {
  let chainId: number | undefined;
  try {
    chainId = activeChain().id;
  } catch {
    // chain-config should never throw, but a health probe must not 500.
    chainId = undefined;
  }
  return NextResponse.json({ ok: true, service: 'cardo', chainId });
}
