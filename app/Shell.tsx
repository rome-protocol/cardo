// Client shell — wraps every route with the designer's V3 Nav + Footer.
//
// V3 designer's App placed <Nav/> and <Footer/> around every route. Mirror
// that structure for Next.js via this 'use client' wrapper. Nav expects
// prop `onNav` (not `onNavigate`) and a required `wallet` object with
// `.connected`, `.address`, `.balanceUSD`, `.network`. See
// wallet-context.tsx for the wagmi-backed provider.
//
// A network-mismatch banner renders above {children} when the connected
// wallet is on a chain other than Rome chain (200010).

'use client';

import dynamic from 'next/dynamic';
import { usePathname, useRouter } from 'next/navigation';
import { Nav, Footer } from '@/components/primitives';
import { DesignShell } from '@/components/design/DesignShell';
import { WalletProvider, useWallet } from './wallet-context';

// The orchestrator's Solana chrome is loaded only on /orchestrator so the
// Solana wallet-adapter deps + CSS don't ship on every route.
const SolanaOrchestratorChrome = dynamic(
  () => import('./orchestrator/SolanaOrchestratorChrome').then((m) => m.SolanaOrchestratorChrome),
  { ssr: false },
);

// /perps is a Solana-wallet surface too (Jupiter Perps, mainnet) — its own
// Solana chrome, loaded only on /perps so the wallet-adapter deps stay off
// every other route.
const PerpsChrome = dynamic(
  () => import('./perps/PerpsChrome').then((m) => m.PerpsChrome),
  { ssr: false },
);

// Routes rebuilt in the act|see dark design. They render inside DesignShell
// (its own dark header/footer) instead of the legacy light Nav. Grows as each
// page is converted.
// Top-nav routes live in DesignShell's NAV. Variant venues (stake-marinade,
// lend-drift, …) are redesigned + render in the dark shell but stay out of the
// top nav to keep it lean — reached by URL / future venue-pickers.
const REDESIGNED = new Set<string>([
  '/', '/swap', '/orca', '/lend', '/stake', '/pay', '/send', '/bridge',
  '/stake-marinade', '/lend-drift', '/lend-mango',
  '/swap-dlmm', '/swap-meteora-v2', '/swap-raydium', '/swap-raydium-amm', '/swap-raydium-clmm',
  '/swap-phoenix', '/swap-pumpfun', '/swap-pumpswap',
  '/compose', '/vote', '/pool/new',
]);

function NetworkMismatchBanner() {
  const { wallet, switchToChain } = useWallet();
  if (!wallet.isWrongNetwork) return null;
  return (
    <div
      style={{
        background: 'rgba(198,159,31,0.12)',
        borderBottom: '1px solid rgba(198,159,31,0.3)',
        padding: '10px 0',
        textAlign: 'center',
        fontSize: 13,
      }}
    >
      You&apos;re on chain {wallet.chainId}. Switch to{' '}
      <strong>Rome chain</strong> to use Cardo.{' '}
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        style={{ marginLeft: 12 }}
        onClick={switchToChain}
      >
        Switch network
      </button>
    </div>
  );
}

function ShellInner({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname() ?? '/';
  const { wallet, connect, disconnect, openAccount, switchToChain } = useWallet();

  // /orchestrator is a Solana-native (Phantom, mainnet) surface, but it's still
  // Cardo — it wears the same act|see chrome (brand + dark nav + footer) in a
  // `solana` mode: a "Solana · Mainnet" pill replaces the EVM chain switcher /
  // wallet (its own Solana wallet lives in-content), and the EVM wrong-network
  // banner is suppressed. This keeps it native to Cardo, not a light orphan.
  if (pathname.startsWith('/orchestrator')) {
    return (
      <div data-route={pathname}>
        <SolanaOrchestratorChrome
          route={pathname}
          evmWallet={wallet}
          onConnect={connect}
          onOpenWallet={openAccount}
          onSwitchChain={switchToChain}
        >
          {children}
        </SolanaOrchestratorChrome>
      </div>
    );
  }

  // /perps is a first-class Solana-wallet surface (Jupiter Perps, mainnet) —
  // same act|see chrome in `solana` mode as the Orchestrator, its own Solana
  // wallet button in the header.
  if (pathname.startsWith('/perps')) {
    return (
      <div data-route={pathname}>
        <PerpsChrome
          route={pathname}
          evmWallet={wallet}
          onConnect={connect}
          onOpenWallet={openAccount}
          onSwitchChain={switchToChain}
        >
          {children}
        </PerpsChrome>
      </div>
    );
  }

  // act|see redesigned routes render inside the dark DesignShell (its own
  // header/footer/network banner), where the legacy light Nav used to sit.
  if (REDESIGNED.has(pathname)) {
    return (
      <div data-route={pathname}>
        <DesignShell
          route={pathname}
          wallet={wallet}
          onConnect={connect}
          onOpenWallet={openAccount}
          onSwitchChain={switchToChain}
        >
          {children}
        </DesignShell>
      </div>
    );
  }

  return (
    <div data-route={pathname}>
      <Nav
        route={pathname}
        onNav={(path: string) => router.push(path)}
        wallet={wallet}
        onConnect={connect}
        onDisconnect={disconnect}
        onOpenWallet={openAccount}
      />
      <NetworkMismatchBanner />
      {children}
      <Footer />
    </div>
  );
}

export default function Shell({ children }: { children: React.ReactNode }) {
  return (
    <WalletProvider>
      <ShellInner>{children}</ShellInner>
    </WalletProvider>
  );
}
