'use client';
// Chrome for /perps: the act|see DesignShell wrapped in the Solana wallet
// providers, so the Solana wallet button lives in the header — exactly like
// every other route shows its wallet. Perps run on Jupiter Perps (Solana
// mainnet, user custody), so /perps is a first-class Solana-wallet surface
// (like the Orchestrator), not the EVM/Rome-CPI lane the act|see dapp routes use.
//
// EVM wallet props are threaded through (DesignShell's type wants them) but
// ignored in chain="solana" mode.

import dynamic from 'next/dynamic';
import type { Wallet } from '../wallet-context';
import { DesignShell } from '@/components/design/DesignShell';
import s from '@/components/design/actsee.module.css';
import SolanaWalletProviders from '../orchestrator/SolanaWalletProviders';

const WalletMultiButton = dynamic(
  () => import('@solana/wallet-adapter-react-ui').then((m) => m.WalletMultiButton),
  { ssr: false },
);

export function PerpsChrome({
  route,
  evmWallet,
  onConnect,
  onOpenWallet,
  onSwitchChain,
  children,
}: {
  route: string;
  evmWallet: Wallet;
  onConnect: () => void;
  onOpenWallet: () => void;
  onSwitchChain: () => void;
  children: React.ReactNode;
}) {
  return (
    <SolanaWalletProviders>
      <DesignShell
        route={route}
        chain="solana"
        wallet={evmWallet}
        onConnect={onConnect}
        onOpenWallet={onOpenWallet}
        onSwitchChain={onSwitchChain}
        headerRight={
          <>
            <span className={s.chainpill} style={{ cursor: 'default' }} title="Perps run on Jupiter Perps · Solana Mainnet">
              <span className={`${s.dot} ${s.sol}`} /> Solana <span className={s.chainid}>· Mainnet</span>
            </span>
            <WalletMultiButton />
          </>
        }
      >
        {children}
      </DesignShell>
    </SolanaWalletProviders>
  );
}
