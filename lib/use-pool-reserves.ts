// usePoolReserves — the selected Meteora DAMM v1 pool's REAL reserves.
//
// DAMM v1 parks each pool token in a SHARED dynamic vault and records the
// pool's stake as vault-LP tokens. So a pool's reserve is its LP share of the
// vault, not the vault's whole balance (which serves every pool on that vault):
//   reserve = poolVaultLpBalance * vault.total_amount / vaultLpMint.supply
// Reading the raw token-vault balance instead over-quotes massively → the
// enforced minimumOut lands above what the pool can pay → swaps revert on
// slippage (Custom(6004)). This computes the share correctly.
//
// One getMultipleAccounts reads all six accounts; we decode by fixed offset:
//   dynamic-vault: total_amount  u64 LE @ 11   (see use-meteora-vault-states)
//   SPL token acct: amount       u64 LE @ 64
//   SPL mint:       supply       u64 LE @ 36

import { useEffect, useState } from 'react';
import type { Hex } from 'viem';
import { bytes32ToPublicKey } from './solana-pda';
import { effectiveReserve } from './pool-quote';

export type PoolReserves = {
  reserveA?: bigint; // token A (splMintA) — pool's share
  reserveB?: bigint; // token B (splMintB)
  loading: boolean;
};

type PoolVaultRefs = {
  aVault: Hex; bVault: Hex;
  aVaultLp: Hex; bVaultLp: Hex;
  aVaultLpMint: Hex; bVaultLpMint: Hex;
};

const REFRESH_MS = 8_000;
const VAULT_TOTAL_OFFSET = 11;
const TOKEN_AMOUNT_OFFSET = 64;
const MINT_SUPPLY_OFFSET = 36;

function u64LE(buf: Buffer, offset: number): bigint {
  if (buf.length < offset + 8) return 0n;
  return buf.readBigUInt64LE(offset);
}

/// One-shot imperative read of a pool's real (LP-share) reserves. The
/// pure core the hook polls — also reused by the compose executor, which
/// runs sequentially and can't hold a hook per step. Returns both
/// reserves undefined when any of the six accounts can't be read.
export async function fetchPoolReserves(
  pool: PoolVaultRefs,
): Promise<{ reserveA?: bigint; reserveB?: bigint }> {
  const keys = [
    pool.aVault, pool.bVault, pool.aVaultLp, pool.bVaultLp, pool.aVaultLpMint, pool.bVaultLpMint,
  ].map((h) => bytes32ToPublicKey(h).toBase58());
  const res = await fetch('/api/rpc/solana-devnet', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts',
      params: [keys, { encoding: 'base64', commitment: 'confirmed' }],
    }),
  });
  const json = await res.json();
  const vals = (json?.result?.value ?? []) as Array<{ data?: [string, string] } | null>;
  const buf = (i: number) => {
    const d = vals[i]?.data?.[0];
    return d ? Buffer.from(d, 'base64') : undefined;
  };
  const [aVault, bVault, aLp, bLp, aMint, bMint] = [0, 1, 2, 3, 4, 5].map(buf);
  if (!aVault || !bVault || !aLp || !bLp || !aMint || !bMint) return {};
  return {
    reserveA: effectiveReserve(
      u64LE(aLp, TOKEN_AMOUNT_OFFSET), u64LE(aVault, VAULT_TOTAL_OFFSET), u64LE(aMint, MINT_SUPPLY_OFFSET),
    ),
    reserveB: effectiveReserve(
      u64LE(bLp, TOKEN_AMOUNT_OFFSET), u64LE(bVault, VAULT_TOTAL_OFFSET), u64LE(bMint, MINT_SUPPLY_OFFSET),
    ),
  };
}

export function usePoolReserves(pool: PoolVaultRefs | undefined): PoolReserves {
  const [state, setState] = useState<PoolReserves>({ loading: true });

  const keys = pool
    ? [pool.aVault, pool.bVault, pool.aVaultLp, pool.bVaultLp, pool.aVaultLpMint, pool.bVaultLpMint]
        .map((h) => bytes32ToPublicKey(h).toBase58())
    : undefined;
  const keyId = keys?.join('|');

  useEffect(() => {
    if (!keys) {
      setState({ loading: false });
      return;
    }
    let cancelled = false;
    const run = async () => {
      try {
        const { reserveA, reserveB } = await fetchPoolReserves(pool!);
        if (cancelled) return;
        if (reserveA === undefined || reserveB === undefined) {
          setState({ loading: false });
          return;
        }
        setState({ reserveA, reserveB, loading: false });
      } catch {
        if (!cancelled) setState((s) => ({ ...s, loading: false }));
      }
    };
    run();
    const id = setInterval(run, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [keyId]); // eslint-disable-line react-hooks/exhaustive-deps

  return state;
}
