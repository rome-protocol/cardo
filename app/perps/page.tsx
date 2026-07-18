// /perps — Cardo's perpetual-futures surface. Jupiter Perps on Solana
// mainnet (request-fulfillment), the Solana-wallet lane. The Solana wallet
// providers wrap the whole /perps chrome (see app/Shell.tsx → PerpsChrome)
// so the wallet button lives in the shared header; this page is just content.

'use client';

import PerpsClient from './PerpsClient';

export default function PerpsPage() {
  return <PerpsClient />;
}
