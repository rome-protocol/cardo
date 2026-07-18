// Runtime env shape shared by the /api/env route (server, reads process.env at
// request time) and the EnvProvider (client, fetches /api/env). Mirrors
// the Rome web app's src/lib/config/runtimeEnv — the contract that lets ONE Docker image
// serve any chain: nothing chain-specific is inlined into the client bundle at
// build time; the browser learns its chain + WalletConnect id at runtime.
//
// Leaf module — no chain-config / registry imports, so /api/env stays lean.

export type RuntimeEnv = {
  /** Active Rome chain id for this deployment (container env `ROME_CHAIN_ID`). */
  chainId: number;
  /** WalletConnect (Reown) project id; '' disables the WC/Rainbow connectors. */
  walletConnectProjectId: string;
  /** rome-bridge-api base URL (container env `BRIDGE_API_BASE`). */
  bridgeApiBase: string;
};

// Default chain when nothing is set — Hadrian (200010, Rome devnet). Kept as a
// literal (not imported from chain-config) so this module stays dependency-free;
// chain-config validates the id against the registry-backed CHAINS map.
export const DEFAULT_CHAIN_ID = 200010;

// Matches DEFAULT_BRIDGE_API_BASE in bridge-api-client (kept literal — leaf module).
export const DEFAULT_BRIDGE_API_BASE_ENV = 'https://bridge-api.devnet.romeprotocol.xyz';

export const DEFAULT_RUNTIME_ENV: RuntimeEnv = {
  chainId: DEFAULT_CHAIN_ID,
  walletConnectProjectId: '',
  bridgeApiBase: DEFAULT_BRIDGE_API_BASE_ENV,
};

/** Coerce an unknown /api/env payload into a valid RuntimeEnv (both ends use it). */
export function normalizeRuntimeEnv(raw: unknown): RuntimeEnv {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const n = Number(o.chainId);
  const base = typeof o.bridgeApiBase === 'string' && /^https?:\/\//.test(o.bridgeApiBase)
    ? o.bridgeApiBase.replace(/\/+$/, '')
    : DEFAULT_BRIDGE_API_BASE_ENV;
  return {
    chainId: Number.isFinite(n) && n > 0 ? n : DEFAULT_CHAIN_ID,
    walletConnectProjectId:
      typeof o.walletConnectProjectId === 'string' ? o.walletConnectProjectId : '',
    bridgeApiBase: base,
  };
}
