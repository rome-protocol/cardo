// useUserPools — local persistence of Meteora pools the user has just
// created via /pool/new. Keeps them showing up in /swap's fee-tier
// picker until a real on-chain registry catches up. Stored in
// localStorage so the entry survives page reloads.
//
// We persist the *full account set* (pool, vaults, vault LPs, fee
// ATAs, mint addresses) rather than rederiving from the input mints
// + feeBps because:
//   - aTokenVault / lpMint can come from non-PDA legacy vaults
//   - Reading them on-demand requires extra Solana RPC round-trips
//     in /swap's hot path
// Storing the snapshot makes the swap routing pure-local once a pool
// is known.
//
// Schema is versioned in the localStorage key.

import { useCallback, useEffect, useState } from 'react';
import type { Hex } from 'viem';

const STORAGE_KEY = 'cardo:user-pools:v1';

export type UserPool = {
  /// Display label, e.g. "rTSLA / WUSDC @ 0.25%". Computed once at
  /// persist time so the swap picker doesn't have to re-look-up
  /// symbols.
  label: string;
  feeBps: number;
  /// The full account set in bytes32 hex form — same shape Meteora
  /// swap uses. Caller-side A/B order is preserved.
  pool: {
    pool: Hex;
    aVault: Hex;
    bVault: Hex;
    aVaultLp: Hex;
    bVaultLp: Hex;
    aTokenVault: Hex;
    bTokenVault: Hex;
    aVaultLpMint: Hex;
    bVaultLpMint: Hex;
    vaultProgram: Hex;
    tokenProgram: Hex;
    protocolTokenAFee: Hex;
    protocolTokenBFee: Hex;
    splMintA: Hex;
    splMintB: Hex;
  };
  /// EVM wrapper addresses (lowercased) for both sides — lets the
  /// swap UI light up the picker for whichever wrapper symbols exist.
  wrapperA: string;
  wrapperB: string;
  /// Symbols at persist time. Display only; not authoritative.
  symbolA: string;
  symbolB: string;
};

function read(): UserPool[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(pools: UserPool[]) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pools));
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[cardo] failed to persist user pools', e);
  }
}

export function useUserPools(): {
  pools: UserPool[];
  add: (p: UserPool) => void;
  clear: () => void;
} {
  const [pools, setPools] = useState<UserPool[]>([]);
  useEffect(() => { setPools(read()); }, []);

  const add = useCallback((p: UserPool) => {
    setPools((prev) => {
      // Dedupe by pool pubkey (lowercased).
      const key = p.pool.pool.toLowerCase();
      const filtered = prev.filter((x) => x.pool.pool.toLowerCase() !== key);
      const next = [...filtered, p];
      write(next);
      return next;
    });
  }, []);

  const clear = useCallback(() => { setPools([]); write([]); }, []);

  return { pools, add, clear };
}
