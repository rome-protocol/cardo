// useMeteoraVaultsExist — pre-flight check that the Meteora dynamic-vault
// for each token mint already exists. Pool init reads vault state, so a
// missing vault aborts the whole tx with a confusing AccountNotInitialized
// error — we'd rather catch it ahead of time and show a clear message.
//
// Reads via /api/rpc/solana-devnet (same proxy used by useSolanaTokenBalances).

import { useEffect, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import {
  deriveMeteoraVault,
  METEORA_VAULT_PROGRAM_ID,
} from './meteora-pool-create';
import { bytes32ToPublicKey } from './solana-pda';
import type { Hex } from 'viem';

type VaultStatus = 'unknown' | 'exists' | 'missing';

export type VaultsExist = {
  /// Per-mint result keyed by lowercased mint hex.
  byMint: Record<string, VaultStatus>;
  /// `true` if every supplied mint has a known vault.
  allExist: boolean;
  /// `true` while the read is in flight.
  loading: boolean;
};

/// Same poll cadence as useMeteoraVaultStates so the &quot;✓ exists&quot; row
/// flips automatically a few seconds after a vault.initialize tx
/// confirms — no manual page reload needed.
const REFRESH_MS = 8_000;

export function useMeteoraVaultsExist(mintHexList: readonly Hex[]): VaultsExist & { refresh: () => void } {
  const [status, setStatus] = useState<Record<string, VaultStatus>>({});
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);

  useEffect(() => {
    if (mintHexList.length === 0) {
      setStatus({});
      return;
    }
    let cancelled = false;
    setLoading(true);

    const tick = async () => {
      try {
        const vaults = mintHexList.map((mintHex) => {
          const mint = bytes32ToPublicKey(mintHex);
          return {
            mintHex: mintHex.toLowerCase(),
            vault: deriveMeteoraVault(mint).toBase58(),
          };
        });
        const res = await fetch('/api/rpc/solana-devnet', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getMultipleAccounts',
            params: [vaults.map((v) => v.vault), { encoding: 'base64' }],
          }),
        });
        const json = await res.json();
        if (cancelled) return;
        const values = (json.result?.value ?? []) as Array<
          { owner?: string } | null
        >;
        const out: Record<string, VaultStatus> = {};
        vaults.forEach((v, i) => {
          const acc = values[i];
          if (!acc) {
            out[v.mintHex] = 'missing';
            return;
          }
          // Only count it as "exists" if the account is actually owned by
          // Meteora's vault program — guards against an unrelated account
          // happening to land at the same PDA.
          if (acc.owner === METEORA_VAULT_PROGRAM_ID.toBase58()) {
            out[v.mintHex] = 'exists';
          } else {
            out[v.mintHex] = 'missing';
          }
        });
        setStatus(out);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[cardo pool-create] vault existence check failed', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    tick();
    const id = setInterval(tick, REFRESH_MS);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [mintHexList.map((m) => m.toLowerCase()).join('|'), tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const allExist =
    mintHexList.length > 0 &&
    mintHexList.every((m) => status[m.toLowerCase()] === 'exists');

  return { byMint: status, allExist, loading, refresh };
}

// Force PublicKey import to be retained in compiled JS even when the type-only
// branch above doesn't reference it.
void PublicKey;
