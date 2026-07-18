'use client';
// Chrome for /orchestrator: the act|see DesignShell, but wrapped in the Solana
// wallet providers so the Solana wallet button can live in the header — exactly
// where every other route shows its wallet. This is what makes the orchestrator
// a first-class Cardo surface (like Swap/Stake) rather than a link to an orphan.
//
// The EVM wallet props are still threaded through (DesignShell's type wants
// them) but ignored in `chain="solana"` mode.

import dynamic from 'next/dynamic';
import type { Wallet } from '../wallet-context';
import { DesignShell } from '@/components/design/DesignShell';
import s from '@/components/design/actsee.module.css';
import SolanaWalletProviders from './SolanaWalletProviders';

const WalletMultiButton = dynamic(
  () => import('@solana/wallet-adapter-react-ui').then((m) => m.WalletMultiButton),
  { ssr: false },
);

export function SolanaOrchestratorChrome({
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
            <span className={s.chainpill} style={{ cursor: 'default' }} title="The Orchestrator runs on Solana Mainnet">
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
