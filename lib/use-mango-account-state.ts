// useMangoAccountState — read-only check for "did the user already
// run accountCreate for this Mango Group?". Drives the page's
// step-skipping UI.
//
// Hits /api/rpc/solana-devnet for one getAccountInfo call against the
// derived MangoAccount PDA. Re-fetches on a poll interval so the UI
// flips to "deposit/withdraw" shortly after a successful accountCreate
// confirms on Solana.

import { useCallback, useEffect, useState } from 'react';
import type { Address, Hex } from 'viem';
import {
  bytes32ToPublicKey,
  deriveRomeUserPda,
} from './solana-pda';
import { deriveMangoAccount } from './mango-pdas';

const RPC = '/api/rpc/solana-devnet';
const POLL_MS = 8_000;

export type MangoAccountFlags = {
  loading: boolean;
  /// True when the per-user MangoAccount PDA exists on Solana.
  accountExists: boolean;
  mangoAccountPda?: Hex;
  /// Re-probe immediately (playbook §4b.5) — call on accountCreate/close
  /// success so the screen flips without waiting for the next poll.
  refresh: () => void;
};

export function useMangoAccountState(
  userEvmAddress: Address | undefined,
  groupHex: Hex,
  accountNum = 0,
): MangoAccountFlags {
  const [flags, setFlags] = useState<Omit<MangoAccountFlags, 'refresh'>>({
    loading: true,
    accountExists: false,
  });
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!userEvmAddress) {
      setFlags({ loading: false, accountExists: false });
      return;
    }
    let cancelled = false;
    let mangoAccountPda: Hex;
    try {
      const owner = deriveRomeUserPda(userEvmAddress);
      mangoAccountPda = deriveMangoAccount({
        groupHex,
        ownerHex: owner,
        accountNum,
      });
    } catch {
      setFlags({ loading: false, accountExists: false });
      return;
    }
    const pdaBs58 = bytes32ToPublicKey(mangoAccountPda).toBase58();

    // Same race-fix pattern as `useDriftSpotInitState`: reset to
    // loading=true at the top so the screen never renders the create
    // CTA on stale "doesn't exist" data.
    setFlags({ loading: true, accountExists: false, mangoAccountPda });

    const probe = async () => {
      try {
        const res = await fetch(RPC, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getAccountInfo',
            // 'confirmed' so the probe sees the account as soon as the
            // create tx's Rome receipt lands (default finalized lags ~13s+,
            // which read as "button never refreshes").
            params: [pdaBs58, { encoding: 'base64', commitment: 'confirmed' }],
          }),
        });
        const json = await res.json();
        if (cancelled) return;
        setFlags({
          loading: false,
          accountExists: !!json?.result?.value,
          mangoAccountPda,
        });
      } catch {
        if (!cancelled) {
          setFlags({
            loading: false,
            accountExists: false,
            mangoAccountPda,
          });
        }
      }
    };
    void probe();
    const id = setInterval(probe, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [userEvmAddress, groupHex, accountNum, tick]);

  return { ...flags, refresh };
}
