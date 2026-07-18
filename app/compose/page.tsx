// Compose route `/compose` — V3 designer's flagship Compose screen.
// Visual layer in components/screens/Compose.jsx (byte-preserved). Wallet
// + connect handler come from the shared WalletProvider. `pathStyle`
// defaults to the designer's "horizontal" layout (matches TWEAK_DEFAULTS
// in Cardo.html).

'use client';

import { Compose } from '@/components/screens/Compose';
import { useWallet } from '../wallet-context';

export default function Page() {
  const { wallet, connect } = useWallet();
  return <Compose wallet={wallet} onConnect={connect} pathStyle="horizontal" />;
}
