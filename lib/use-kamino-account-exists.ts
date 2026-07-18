// Pre-flight existence checks for Kamino UserMetadata + Obligation.
//
// Both are deterministic PDAs (derived in lib/kamino-pdas.ts). We
// query Solana via the same /api/rpc/solana-devnet proxy used by
// useSolanaTokenBalances + useMeteoraVaultStates.
//
// Pattern: 8s polling + explicit `refresh()` per playbook §4b.5.
// Setup hook calls refresh() on success so the UI flips state without
// a manual reload.
//
// Owner reference for both PDAs: KLEND program.

import { useCallback, useEffect, useState } from 'react';
import type { Address, Hex } from 'viem';
import {
  deriveUserMetadata,
  deriveVanillaObligation,
} from './kamino-pdas';
import { bytes32ToPublicKey, deriveRomeUserPda } from './solana-pda';

export type KaminoAccountStatus = 'unknown' | 'exists' | 'missing';

const KLEND_OWNER = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD';
const REFRESH_MS = 8_000;

async function probe(addressBs58: string): Promise<KaminoAccountStatus> {
  try {
    const res = await fetch('/api/rpc/solana-devnet', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getAccountInfo',
        // 'confirmed' so the post-setup refresh() sees fresh accounts
        // immediately (finalized lags the Rome receipt by ~13s+).
        params: [addressBs58, { encoding: 'base64', commitment: 'confirmed' }],
      }),
    });
    const json = await res.json();
    const acc = json.result?.value;
    if (!acc) return 'missing';
    return acc.owner === KLEND_OWNER ? 'exists' : 'missing';
  } catch {
    return 'unknown';
  }
}

// ─────────────────────────────────────────────────────────────────────
// useKaminoUserMetadataExists — one per user (market-independent).
// ─────────────────────────────────────────────────────────────────────

export function useKaminoUserMetadataExists(
  userEvmAddress: Address | undefined,
): {
  status: KaminoAccountStatus;
  userMetadata?: Hex;
  loading: boolean;
  refresh: () => void;
} {
  const [status, setStatus] = useState<KaminoAccountStatus>('unknown');
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  // Memoized so callers can include `refresh` in useEffect deps
  // without re-running on every render.
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const userMetadata = userEvmAddress
    ? deriveUserMetadata(deriveRomeUserPda(userEvmAddress))
    : undefined;

  useEffect(() => {
    if (!userMetadata) {
      setStatus('unknown');
      return;
    }
    let cancelled = false;
    const bs58 = bytes32ToPublicKey(userMetadata).toBase58();
    const run = async () => {
      setLoading(true);
      const s = await probe(bs58);
      if (!cancelled) setStatus(s);
      if (!cancelled) setLoading(false);
    };
    run();
    const id = setInterval(run, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [userMetadata, tick]);

  return { status, userMetadata, loading, refresh };
}

// ─────────────────────────────────────────────────────────────────────
// useKaminoObligationExists — one per (user, market). Vanilla.
// ─────────────────────────────────────────────────────────────────────

export function useKaminoObligationExists(args: {
  userEvmAddress: Address | undefined;
  lendingMarket: Hex | undefined;
}): {
  status: KaminoAccountStatus;
  obligation?: Hex;
  loading: boolean;
  refresh: () => void;
} {
  const [status, setStatus] = useState<KaminoAccountStatus>('unknown');
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  // Memoized so callers can include `refresh` in useEffect deps
  // without re-running on every render.
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const obligation =
    args.userEvmAddress && args.lendingMarket
      ? deriveVanillaObligation(
          deriveRomeUserPda(args.userEvmAddress),
          args.lendingMarket,
        )
      : undefined;

  useEffect(() => {
    if (!obligation) {
      setStatus('unknown');
      return;
    }
    let cancelled = false;
    const bs58 = bytes32ToPublicKey(obligation).toBase58();
    const run = async () => {
      setLoading(true);
      const s = await probe(bs58);
      if (!cancelled) setStatus(s);
      if (!cancelled) setLoading(false);
    };
    run();
    const id = setInterval(run, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [obligation, tick]);

  return { status, obligation, loading, refresh };
}
