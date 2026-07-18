'use client';
// Solana wallet adapter scoped to /orchestrator.
//
// Why scoped here (not in app/Shell.tsx): the rest of Cardo uses an EVM
// wallet (RainbowKit/wagmi). The orchestrator is a Solana-native product,
// and mixing the two providers globally would clutter every page with
// modal CSS and connection state it doesn't need.
//
// Mounted by app/orchestrator/page.tsx so only this surface gets the
// Phantom/Backpack/Solflare adapters + WalletModal CSS.

import React, { useMemo } from 'react';
import {
  ConnectionProvider,
  WalletProvider,
} from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
} from '@solana/wallet-adapter-wallets';
import '@solana/wallet-adapter-react-ui/styles.css';

// Use the public RPC for client-side reads; the server side (with
// dedicated RPC keys) does the heavy work. Browser only needs balance + status
// pings, which the public endpoint handles fine.
const CLIENT_RPC =
  process.env.NEXT_PUBLIC_SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com';

export default function SolanaWalletProviders({
  children,
}: {
  children: React.ReactNode;
}) {
  // Backpack auto-injects via Wallet Standard, so we don't need an explicit
  // adapter for it. Phantom + Solflare cover the bulk of Solana users; the
  // Wallet Standard discovery picks up everything else automatically.
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    [],
  );

  return (
    <ConnectionProvider endpoint={CLIENT_RPC}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
