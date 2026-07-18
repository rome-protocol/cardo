// wagmi + RainbowKit config for Cardo — registry-driven chains.
//
// Target chains come from `lib/chain-config.ts` — the registry-generated
// set (every non-retired devnet+testnet chain in the installed
// `@rome-protocol/registry` pin; see scripts/build-chain-config.ts). ALL of
// them are registered here so the wallet can switch on any deployment; the
// active chain is the runtime `ROME_CHAIN_ID` (default Hadrian 200010), and
// the header ChainSwitcher scopes its MENU to the active chain's network.
//
// Wallet connectors: injected-first (EIP-6963 / browser extensions like
// MetaMask), with WalletConnect added ONLY when a real
// NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is set. This mirrors the Rome web app's
// WagmiConfig (WC is opt-in on a real Reown project id). The previous
// `getDefaultConfig` path ALWAYS bundled WalletConnect and required a
// valid projectId; with a placeholder it 403s against api.web3modal.org
// and the connect modal hangs at "Opening MetaMask…" — so MetaMask never
// connects. Injected-first means the extension path works with no
// projectId at all.
//
// IMPORTANT — Multicall3 is NOT deployed on Rome. wagmi's default
// transport batches `useReadContracts` through Multicall3 at
// `0xcA11...CA11`; on Rome that address has zero bytecode, so every
// batched read silently fails. We omit `contracts.multicall3` on each
// chain so viem skips Multicall3 batching and each read goes out as a
// plain `eth_call`. JSON-RPC HTTP batching is also disabled on the
// transport until we measure the proxy's tolerance.

import { defineChain, type Chain } from 'viem';
import { sepolia } from 'viem/chains';
import { createConfig, http } from 'wagmi';
import { connectorsForWallets } from '@rainbow-me/rainbowkit';
import {
  injectedWallet,
  metaMaskWallet,
  rainbowWallet,
  walletConnectWallet,
} from '@rainbow-me/rainbowkit/wallets';
import { activeChain, allChains, getChainConfig, HADRIAN_CHAIN_ID, type RomeChainConfig } from './chain-config';

// Browser RPC URL. Rome's upstream proxy doesn't emit CORS headers, so
// page-side programmatic reads route through the same-origin Next.js API
// route at /api/rpc/rome (which forwards to the active chain's RPC). In
// Node (build-time prerender) `window` is undefined; fall back to the
// upstream there since CORS isn't enforced server-side.
//
// MetaMask and other wallets still talk to the chain's RPC directly via
// the chain definition's `rpcUrls`; this proxy is just for wagmi's
// programmatic reads from the page.
function browserRpc(cfg: RomeChainConfig): string {
  return typeof window !== 'undefined'
    ? `${window.location.origin}/api/rpc/rome`
    : cfg.rpcUrl;
}

// Sepolia RPC for the inbound-bridge source-chain reads (burn-receipt waits in
// use-inbound-{cctp,wh}-send). Browser → same-origin /api/rpc/sepolia proxy
// (CORS + internal-override via SEPOLIA_RPC_URL); Node → the registry bridge.json
// Sepolia RPC. Sepolia is registered so the wallet can switch to it for the burn;
// it is NOT a Cardo dapp chain (absent from allChains() → not in the switcher).
function sepoliaRpc(): string {
  if (typeof window !== 'undefined') return `${window.location.origin}/api/rpc/sepolia`;
  return (
    getChainConfig(HADRIAN_CHAIN_ID).bridge?.sourceEvm.rpcUrl ??
    'https://ethereum-sepolia-rpc.publicnode.com'
  );
}

function defineRomeChain(cfg: RomeChainConfig) {
  return defineChain({
    id: cfg.id,
    name: cfg.name,
    nativeCurrency: cfg.nativeCurrency,
    // Wallet-facing RPC is the chain's upstream — MetaMask/users add it
    // directly. Page reads go through the Next.js proxy (set on the
    // transport below).
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
    blockExplorers: {
      default: { name: 'Rome Via', url: cfg.explorerUrl },
    },
    testnet: true,
    // No `contracts.multicall3` — viem skips Multicall3 batching (Rome
    // has no Multicall3; useReadContracts would silently fail otherwise).
  });
}

// Active chain (the one Cardo BOOT-defaults to). Preserved export name — some
// hooks import `rome` for its nativeCurrency / explorer. NOTE: this is the boot
// default; client read-hooks should key reads on the RUNTIME chain via
// `useActiveChainId()`, not `rome.id`, so one image serves any chain.
export const rome = defineRomeChain(activeChain());

/// Build a wagmi config for a given runtime chain + WalletConnect project id.
///
/// FACTORY (not a module-level const) — that's what lets ONE image serve any
/// chain: the provider rebuilds this from `/api/env` values at runtime. Every
/// registered Rome chain is included (so the wallet can switch), with the
/// active `chainId` placed FIRST so it's wagmi's default. Mirrors the Rome web app's
/// `createWagmiConfig` + aerarium's.
export function createWagmiConfig(chainId: number, walletConnectProjectId: string) {
  const chains = allChains();
  const ordered = [
    ...chains.filter((c) => c.id === chainId),
    ...chains.filter((c) => c.id !== chainId),
  ];
  const romeChains = (ordered.length > 0 ? ordered : [activeChain()]).map(defineRomeChain);
  // Rome chains + Sepolia (the inbound-bridge source chain). Sepolia is included
  // so the wallet can switch to it for the CCTP burn / Wormhole transfer; it is
  // NOT a Cardo dapp chain (absent from allChains() → not in the dapp switcher).
  const wagmiChains: Chain[] = [...romeChains, sepolia];
  const chainTuple = wagmiChains as [Chain, ...Chain[]];

  // Every registered chain reads through the same-origin proxy in the browser,
  // its upstream RPC in Node. Sepolia routes through /api/rpc/sepolia.
  const transports = {
    ...Object.fromEntries(
      allChains().map((cfg) => [cfg.id, http(browserRpc(cfg), { batch: false })]),
    ),
    [sepolia.id]: http(sepoliaRpc(), { batch: false }),
  };

  // Real WalletConnect Cloud project id, if provided. `||` (not `??`) so an
  // empty string counts as absent. Injected-first: MetaMask + injected always
  // present (extension path, no projectId needed); Rainbow + WalletConnect added
  // ONLY when a real projectId exists (their QR / mobile path needs the Reown
  // relay, and a placeholder 403s against api.web3modal.org and hangs the modal).
  const wcProjectId = walletConnectProjectId || '';
  const connectors = connectorsForWallets(
    [
      { groupName: 'Installed', wallets: [injectedWallet, metaMaskWallet] },
      ...(wcProjectId
        ? [{ groupName: 'More', wallets: [rainbowWallet, walletConnectWallet] }]
        : []),
    ],
    {
      appName: 'Cardo',
      // Only the WC-based wallets use this, and they're omitted unless
      // wcProjectId is real. The fallback string is never sent to Reown.
      projectId: wcProjectId || 'cardo-injected-only',
    },
  );

  return createConfig({
    chains: chainTuple,
    connectors,
    transports,
    ssr: true,
    // EIP-6963 multi-injected discovery: pick up MetaMask + any wallet that
    // announces via `eip6963:announceProvider`, plus the curated list above.
    multiInjectedProviderDiscovery: true,
  });
}

/// Boot config for first render (before /api/env resolves) — the build/boot
/// default chain with no WalletConnect. The provider swaps in the runtime
/// config (real projectId + runtime chain) once `useEnv()` is ready.
export const bootConfig = createWagmiConfig(activeChain().id, '');
