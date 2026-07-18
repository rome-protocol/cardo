// useStakePoolBalances — read the user's Rome-PDA lamports balance and
// per-LST-mint pool-token balances on Solana mainnet, polling every 15s.
//
// Reads from Solana devnet — matching Rome's bridge target. The
// user's rSOL/WWSOL on Rome corresponds to lamports / SPL tokens
// under their Rome PDA on devnet, not mainnet. Mainnet stake-pool
// integrations require Rome mainnet bridge support, which doesn't
// exist today (Sprint 1 ships against a maintained devnet stake pool;
// see lib/stake-pool-registry.ts).
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md
// (Family 1, Phase A — Sprint 1).

import { useEffect, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import type { Address, Hex } from 'viem';
import {
  bytes32ToPublicKey,
  deriveAta,
  deriveRomeUserPda,
} from './solana-pda';

const REFETCH_MS = 15_000;
const RPC = '/api/rpc/solana-devnet';

export type StakePoolBalances = {
  /// User's Rome PDA SOL balance on Solana mainnet, in lamports.
  pdaLamports: bigint;
  /// Per-pool-mint LST token amount, keyed by pool mint as bytes32 hex
  /// (matches the registry's `pool.poolMint` shape). bigint = raw units
  /// (most LSTs are 9 decimals).
  lstAmountsByMint: Record<string, bigint>;
  /// Loading state — true on first fetch, false thereafter.
  loading: boolean;
};

const EMPTY: StakePoolBalances = {
  pdaLamports: 0n,
  lstAmountsByMint: {},
  loading: true,
};

export function useStakePoolBalances(
  /// Pool-mint hexes (`pool.poolMint` from registry entries).
  poolMintHexes: readonly Hex[],
  userEvmAddress: Address | undefined,
): StakePoolBalances {
  const [balances, setBalances] = useState<StakePoolBalances>(EMPTY);

  useEffect(() => {
    if (!userEvmAddress) {
      setBalances({ ...EMPTY, loading: false });
      return;
    }

    let cancelled = false;
    const userPdaHex = deriveRomeUserPda(userEvmAddress);
    const userPda = bytes32ToPublicKey(userPdaHex);

    // Resolve each mint → ATA.
    type Resolved = { mintHex: Hex; ata: PublicKey };
    const resolved: Resolved[] = [];
    for (const mintHex of poolMintHexes) {
      try {
        const ata = bytes32ToPublicKey(deriveAta(userPdaHex, mintHex));
        resolved.push({ mintHex, ata });
      } catch {
        // skip malformed mint
      }
    }

    const fetchOnce = async () => {
      // One getMultipleAccounts call covers PDA lamports + all ATA balances.
      const accounts = [userPda.toBase58(), ...resolved.map((r) => r.ata.toBase58())];
      try {
        const res = await fetch(RPC, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getMultipleAccounts',
            // 'confirmed' so a just-landed stake/unstake shows up within the
            // next poll instead of lagging finalized ~13s+ (a fresh wallet's
            // first unstake found lstBalance=0 for >60s and never enabled).
            params: [accounts, { encoding: 'jsonParsed', commitment: 'confirmed' }],
          }),
        });
        const json = await res.json();
        if (cancelled) return;
        const values = (json.result?.value ?? []) as Array<{
          lamports?: number;
          data?: { parsed?: { info?: { tokenAmount?: { amount?: string } } } };
        } | null>;

        const pdaLamports = BigInt(values[0]?.lamports ?? 0);
        const lstAmountsByMint: Record<string, bigint> = {};
        resolved.forEach((r, i) => {
          const v = values[i + 1];
          const amt = v?.data?.parsed?.info?.tokenAmount?.amount;
          lstAmountsByMint[r.mintHex] =
            amt && /^\d+$/.test(amt) ? BigInt(amt) : 0n;
        });

        setBalances({ pdaLamports, lstAmountsByMint, loading: false });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[cardo stake-pool-balances] fetch failed', e);
        setBalances((prev) => ({ ...prev, loading: false }));
      }
    };

    fetchOnce();
    const id = setInterval(fetchOnce, REFETCH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [
    userEvmAddress,
    poolMintHexes.join('|'),
  ]);

  return balances;
}
