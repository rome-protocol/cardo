// Generic ATA-existence pre-flight. Polls Solana for a user's ATA on
// a given mint and reports status. Used by /lend's pre-flight rows
// to surface "Collateral account: missing" without having to bake
// the check into the action hook.
//
// Per playbook §4b.8 + §4b.11: every protocol-required prerequisite
// the user might be missing is a visible row with its own setup
// button. Action hooks must NOT auto-fire setup steps on the user's
// behalf; the user must see what's about to happen and consent
// before any wallet popup.

import { useCallback, useEffect, useState } from 'react';
import type { Address, Hex } from 'viem';
import { bytes32ToPublicKey, deriveAta, deriveRomeUserPda } from './solana-pda';

export type AtaExistsStatus = 'unknown' | 'exists' | 'missing';

const REFRESH_MS = 8_000;

export function useAtaExists(args: {
  userEvmAddress: Address | undefined;
  /// SPL mint hex (0x-prefixed bytes32). The ATA is derived from
  /// (user's Rome PDA, classic SPL-Token program, mint).
  mintHex: Hex | undefined;
}): {
  status: AtaExistsStatus;
  ataAddress?: Hex;
  loading: boolean;
  refresh: () => void;
} {
  const [status, setStatus] = useState<AtaExistsStatus>('unknown');
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const ataAddress =
    args.userEvmAddress && args.mintHex
      ? deriveAta(deriveRomeUserPda(args.userEvmAddress), args.mintHex)
      : undefined;

  useEffect(() => {
    if (!ataAddress) {
      setStatus('unknown');
      return;
    }
    let cancelled = false;
    const ataBs58 = bytes32ToPublicKey(ataAddress).toBase58();
    const run = async () => {
      setLoading(true);
      try {
        const res = await fetch('/api/rpc/solana-devnet', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getAccountInfo',
            // 'confirmed' so a post-setup refresh() sees the fresh ATA
            // immediately (finalized lags the Rome receipt by ~13s+).
            params: [ataBs58, { encoding: 'base64', commitment: 'confirmed' }],
          }),
        });
        const json = await res.json();
        if (cancelled) return;
        setStatus(json.result?.value ? 'exists' : 'missing');
      } catch {
        if (!cancelled) setStatus('unknown');
      }
      if (!cancelled) setLoading(false);
    };
    run();
    const id = setInterval(run, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [ataAddress, tick]);

  return { status, ataAddress, loading, refresh };
}
