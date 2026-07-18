// Registry-driven Rome chain configuration.
//
// Single source of truth for Cardo's Rome-EVM chain metadata: chain id,
// RPC, explorer, native-gas currency, the canonical SPL wrapper set,
// the chain_mint_id, the ERC20-SPL factory, and the Oracle Gateway V2
// per-feed adapters. Everything here is read from
// `@rome-protocol/registry` JSON (the same package `lib/solana-programs.ts`
// reads program IDs from) — NOT hardcoded. If you find a Rome address or
// chain id hardcoded elsewhere in `lib/`, route it through here.
//
// The chain SET is generated, not hand-listed: `npm run build:chain-config`
// (scripts/build-chain-config.ts, also the first step of `npm run build`)
// projects every non-retired devnet+testnet chain from the installed registry
// pin into `chain-config.generated.json`. Adding a chain — or dropping one
// when the registry retires it — is a registry pin bump + regen, never an
// edit here.
//
// Active chain is `ROME_CHAIN_ID`, read at runtime via /api/env (one image,
// any compiled-in chain — the devnet deploy defaults to Hadrian 200010, the
// testnet deploy pins Martius 121214). The wagmi config registers every
// compiled-in chain so the wallet can switch; the header ChainSwitcher scopes
// its menu to the active chain's network via `chainsForNetwork` so a devnet
// deployment never offers testnet chains (and vice versa). addresses.ts
// surfaces the active chain's wrappers/oracles to the rest of the app.

import generatedChains from './chain-config.generated.json';
import { resolve, type GeneratedChainEntry, type RomeChainConfig } from './chain-resolve';

export type {
  BridgeAsset,
  BridgeConfig,
  RegistryToken,
  RomeChainConfig,
} from './chain-resolve';

export const HADRIAN_CHAIN_ID = 200010;

// Cast through unknown: TS infers exact literal types from the JSON (e.g. the
// oracle feed maps with per-chain optional keys) that don't structurally
// overlap the intentionally-loose Record<string, OracleFeed> shape.
export const CHAINS: Record<number, RomeChainConfig> = Object.fromEntries(
  (generatedChains as unknown as GeneratedChainEntry[]).map((e) => [
    e.chain.chainId,
    resolve(e.chain, e.tokens, e.contracts, e.oracle, e.bridge ?? undefined),
  ]),
);

/// Build/boot default Rome chain id. Default Hadrian (200010, Rome devnet).
///
/// Resolution: `ROME_CHAIN_ID` (runtime, non-`NEXT_PUBLIC_` — the one-image var
/// read live by the standalone server) → `NEXT_PUBLIC_ROME_CHAIN_ID` (back-compat
/// with the old per-chain build-arg images) → Hadrian.
///
/// On the SERVER this reflects the container's runtime env. On the CLIENT it's
/// only the BOOT default (the bundle can't see runtime env) — client code reads
/// the live chain from `/api/env` via `useEnv()` / `useActiveChainId()` and
/// passes it to `activeChain(id)`. Don't use the bare default for client reads.
export const ACTIVE_CHAIN_ID = ((): number => {
  const raw = process.env.ROME_CHAIN_ID ?? process.env.NEXT_PUBLIC_ROME_CHAIN_ID;
  const id = raw ? Number(raw) : HADRIAN_CHAIN_ID;
  if (CHAINS[id]) return id;
  if (raw) {
    // A configured-but-unknown id is an ops mistake (typo'd inventory, or a
    // chain the registry pin doesn't carry) — falling back silently would
    // serve the wrong chain on the right domain. Serve the default, loudly.
    console.error(
      `[chain-config] ROME_CHAIN_ID=${raw} is not in the compiled chain set ` +
        `(${Object.keys(CHAINS).join(', ')}) — falling back to ${HADRIAN_CHAIN_ID}. ` +
        `Wrong-chain deploy? Check the inventory / registry pin.`,
    );
  }
  return HADRIAN_CHAIN_ID;
})();

export function getChainConfig(id: number): RomeChainConfig {
  const c = CHAINS[id];
  if (!c) throw new Error(`chain-config: chain ${id} not configured (have ${Object.keys(CHAINS).join(', ')})`);
  return c;
}

/// CLIENT-side runtime chain, published by EnvProvider — the piece the boot
/// default can't cover: the browser bundle can't see the container's
/// ROME_CHAIN_ID, so without this every bare `activeChain()` in the bundle
/// resolved to the BUILD default (Hadrian) even on a Martius deployment.
/// That froze CPI signer-PDA derivations to the wrong rome-evm program and
/// produced PrivilegeEscalation on every non-default-chain write (2026-07-06).
///
/// EnvProvider sets it when /api/env resolves and when the header switcher
/// changes chain; it must never be called server-side (the server's env-derived
/// ACTIVE_CHAIN_ID is already correct, and module state there is shared across
/// requests). An id outside the compiled set is ignored, not adopted.
let runtimeChainId: number | undefined;

export function setRuntimeChainId(id: number | null | undefined): void {
  runtimeChainId = id != null && CHAINS[id] ? id : undefined;
}

/// Resolve a chain config. Pass the runtime chain id (from `useActiveChainId()`)
/// where you have hook context; bare calls resolve the EnvProvider-published
/// runtime chain, falling back to the boot default before /api/env lands (and
/// always on the server). Falls back to the boot default for an unknown id so
/// callers never get undefined.
export function activeChain(chainId?: number): RomeChainConfig {
  return CHAINS[chainId ?? runtimeChainId ?? ACTIVE_CHAIN_ID] ?? CHAINS[ACTIVE_CHAIN_ID];
}

export function allChains(): RomeChainConfig[] {
  return Object.values(CHAINS);
}

/// The chains a deployment should OFFER — every compiled-in chain on the given
/// network. The ChainSwitcher scopes its menu to the active chain's network so
/// the devnet app never lists testnet chains (and vice versa); wagmi still
/// registers allChains() so wallet switching works either way.
export function chainsForNetwork(network: string): RomeChainConfig[] {
  return allChains().filter((c) => c.network === network);
}

/// Link to a transaction on a chain's Via explorer. Registry-driven
/// (chain.explorerUrl). Pass the runtime chain id on the client; omit for the
/// boot default. Tolerates a trailing slash on the base URL.
export function explorerTxUrl(hash: string, chainId?: number): string {
  const base = activeChain(chainId).explorerUrl.replace(/\/+$/, '');
  return `${base}/tx/${hash}`;
}
