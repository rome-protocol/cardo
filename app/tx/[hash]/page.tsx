// Tx receipt route `/tx/[hash]` — V3 designer's TxReceipt screen. The
// designer's TxReceipt currently renders a hardcoded mock receipt; the
// `[hash]` param is threaded through the route for future use (when
// cardo-service exposes a `GET /tx/:hash` endpoint in v1.5). For now the
// param is unused by the visual layer, which is a v1 scope call per the
// design brief.

'use client';

import { useRouter } from 'next/navigation';
import { TxReceipt } from '@/components/screens/TxReceipt';

export default function Page() {
  const router = useRouter();
  // `params` intentionally unused in v1 — designer's TxReceipt ships with
  // a static mock receipt. Route param captured for v1.5 plumbing.
  return <TxReceipt onNav={(to: string) => router.push(to)} />;
}
