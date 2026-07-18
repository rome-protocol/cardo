// Solana program ID accessor for Cardo.
//
// Single source of truth: the public `@rome-protocol/registry` pin, projected at
// BUILD time into the committed `solana-programs.generated.json` by
// `scripts/build-solana-programs.ts` (the same pattern as chain-config). The
// client imports that JSON, never the registry package — the package resolves
// its data from disk (node:fs/node:url) and must not enter the browser bundle
// (doing so breaks `next build` with an UnhandledSchemeError). If a program ID
// changes (devnet redeploy etc.), update the registry, bump the cardo dep, regen.
//
// Usage:
//
//   import { solanaProgramId } from '@/lib/solana-programs';
//   const KLEND = new PublicKey(solanaProgramId('kaminoLend'));
//   const RAYDIUM = new PublicKey(solanaProgramId('raydiumAmmV4', 'devnet'));
//
// Network defaults to 'mainnet' for orchestrator code (lib/orchestration/*),
// and to 'devnet' for the rest of cardo (which targets Rome / Solana
// devnet via Rome's bridge). Per-call override is always available.

import generated from './solana-programs.generated.json';

const mainnetPrograms = generated.mainnet;
const devnetPrograms = generated.devnet;
const lstMintsMainnet = generated.lstMints;

export type SolanaNetwork = 'mainnet' | 'devnet';

// Union of every key the registry might return. The schema-generated type
// in @rome-protocol/registry is a typed object, but importing the typedef
// across package boundaries without a published dist/ is fragile, so we
// derive the key type from the imported mainnet record. Devnet is a
// subset (some protocols mainnet-only, e.g. kaminoLend).
export type SolanaProgramKey = keyof typeof mainnetPrograms;

/// Look up a program ID by symbolic name + network.
///
/// Throws if the requested key isn't present on the requested network
/// (e.g. `kaminoLend` on devnet) — fail loud rather than silently
/// returning the wrong program. Caller can catch + fall back if they
/// truly want degraded behavior.
export function solanaProgramId(
  key: SolanaProgramKey,
  network: SolanaNetwork = 'mainnet',
): string {
  const table = network === 'mainnet' ? mainnetPrograms : devnetPrograms;
  const id = (table as Record<string, string | undefined>)[key];
  if (!id) {
    throw new Error(
      `solana-programs: ${key} not registered on ${network}. ` +
        `Add it to the registry's solana/programs/${network}.json ` +
        `if it's deployed there, or pass the correct network.`,
    );
  }
  return id;
}

/// LST mint registry (mainnet only — no LST deploys on devnet today).
/// Cardo's orchestrator stake intent ranks across these. Adding a new
/// LST means adding it to registry's lst-mints/mainnet.json + bumping
/// the cardo dep — no code change here.
export type LstSymbol = keyof typeof lstMintsMainnet;
export type LstEntry = (typeof lstMintsMainnet)[LstSymbol];

export function lstMint(symbol: LstSymbol): LstEntry {
  return lstMintsMainnet[symbol];
}

export function listLsts(): LstEntry[] {
  return Object.values(lstMintsMainnet);
}
