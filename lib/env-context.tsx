'use client';
// EnvProvider / useEnv — client access to the runtime config from /api/env,
// plus an in-app chain override.
//
// Two chain ids live here:
//   • deployChainId — what /api/env returned (the chain this image was started
//     with via ROME_CHAIN_ID). The wagmi config is built on this; it never
//     changes after /api/env resolves, so wagmi never remounts on a switch.
//   • chainId       — the ACTIVE chain = override ?? deployChainId. This is what
//     reads/writes target (every hook reads it via useActiveChainId). The header
//     ChainSwitcher sets the override, so a user can switch among the registered
//     chains at runtime without a reload — both chains are already in the wagmi
//     config, so switching is just changing which one hooks point at.
//
// No loading flash: serves DEFAULT_RUNTIME_ENV with ready=false on first render,
// then flips to the fetched values (aerarium's variant of the Rome web app's EnvContext).

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  DEFAULT_RUNTIME_ENV,
  normalizeRuntimeEnv,
  type RuntimeEnv,
} from './runtime-env';
import { activeChain, setRuntimeChainId, type RomeChainConfig } from './chain-config';

type EnvContextValue = RuntimeEnv & {
  /** The chain this image was deployed with (/api/env); wagmi config is built on it. */
  deployChainId: number;
  /** True once /api/env has resolved. */
  ready: boolean;
  /** Switch the active chain at runtime (header dropdown). null clears the override. */
  setChainId: (id: number | null) => void;
};

const EnvContext = createContext<EnvContextValue>({
  ...DEFAULT_RUNTIME_ENV,
  deployChainId: DEFAULT_RUNTIME_ENV.chainId,
  ready: false,
  setChainId: () => {},
});

export function EnvProvider({ children }: { children: React.ReactNode }) {
  // What /api/env returned (the deploy default + WalletConnect id).
  const [fetched, setFetched] = useState<RuntimeEnv & { ready: boolean }>({
    ...DEFAULT_RUNTIME_ENV,
    ready: false,
  });
  // User's in-app chain selection (header dropdown). null = use the deploy default.
  const [override, setOverride] = useState<number | null>(null);

  // Publish the active chain to the non-React world (chain-config's runtime
  // override) so bare `activeChain()` calls — PDA/ATA derivations, address
  // tables, market configs inside instruction builders — resolve the SAME
  // chain the hooks do, instead of the client bundle's build default. Effect
  // only (never runs during SSR); before /api/env lands the boot default holds.
  useEffect(() => {
    setRuntimeChainId(override ?? (fetched.ready ? fetched.chainId : null));
  }, [override, fetched.ready, fetched.chainId]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/env')
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setFetched({ ...normalizeRuntimeEnv(data), ready: true });
      })
      .catch(() => {
        if (!cancelled) setFetched({ ...DEFAULT_RUNTIME_ENV, ready: true });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo<EnvContextValue>(
    () => ({
      chainId: override ?? fetched.chainId,
      deployChainId: fetched.chainId,
      walletConnectProjectId: fetched.walletConnectProjectId,
      bridgeApiBase: fetched.bridgeApiBase,
      ready: fetched.ready,
      setChainId: setOverride,
    }),
    [override, fetched],
  );

  return <EnvContext.Provider value={value}>{children}</EnvContext.Provider>;
}

export function useEnv(): EnvContextValue {
  return useContext(EnvContext);
}

/// The ACTIVE chain id (override ?? deploy default). Client code keys chain
/// reads on this so a runtime switch re-points every hook.
export function useActiveChainId(): number {
  return useEnv().chainId;
}

/// The ACTIVE chain config.
export function useActiveChain(): RomeChainConfig {
  return activeChain(useEnv().chainId);
}
