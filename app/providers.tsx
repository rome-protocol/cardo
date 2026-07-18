// Root-level client providers for Cardo — runtime-env + wagmi + React Query +
// RainbowKit.
//
// One-image model: nothing chain-specific is inlined at build time. EnvProvider
// fetches /api/env at runtime; RuntimeWagmiProvider builds the wagmi config from
// those values (runtime chain id + WalletConnect projectId) and remounts on the
// keyed chain id so every wagmi hook re-binds. Until /api/env resolves we serve
// the boot config (build-default chain, no WalletConnect) so RainbowKit's init
// doesn't throw — no loading flash. Mirrors the Rome web app / aerarium.
//
// Kept a client component so layout.tsx stays a server component (metadata /
// viewport exports stay native). Everything inside has wagmi + RainbowKit +
// useEnv access.

'use client';

import { useMemo, useState } from 'react';
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RainbowKitProvider } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import { bootConfig, createWagmiConfig } from '@/lib/wagmi';
import { EnvProvider, useEnv } from '@/lib/env-context';

function RuntimeWagmiProvider({ children }: { children: React.ReactNode }) {
  const { deployChainId, walletConnectProjectId, ready } = useEnv();
  // Build on the DEPLOY chain (stable after /api/env) — the config registers
  // ALL Rome chains, so an in-app chain switch just re-points hooks at another
  // already-registered chain (via useActiveChainId) without rebuilding wagmi.
  const config = useMemo(
    () => (ready ? createWagmiConfig(deployChainId, walletConnectProjectId) : bootConfig),
    [ready, deployChainId, walletConnectProjectId],
  );
  // Key only on the boot→runtime transition (projectId re-init for RainbowKit) —
  // NOT on the active chain, so switching chains never remounts/disconnects the
  // wallet. (First mount uses bootConfig so RainbowKit init doesn't throw.)
  return (
    <WagmiProvider key={ready ? 'runtime' : 'boot'} config={config}>
      {children}
    </WagmiProvider>
  );
}

export function Providers({ children }: { children: React.ReactNode }) {
  // useState guarantees a single QueryClient per browser session without
  // leaking across SSR boundaries.
  const [queryClient] = useState(() => new QueryClient());

  return (
    <EnvProvider>
      <RuntimeWagmiProvider>
        <QueryClientProvider client={queryClient}>
          <RainbowKitProvider>{children}</RainbowKitProvider>
        </QueryClientProvider>
      </RuntimeWagmiProvider>
    </EnvProvider>
  );
}
