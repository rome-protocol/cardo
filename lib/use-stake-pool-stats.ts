// useStakePoolStats — read each SPL stake pool's reserves (total_lamports,
// pool_token_supply) so the UI can show a REAL exchange rate + TVL instead of a
// hardcoded/"read at submit" placeholder. One base64 getMultipleAccounts over
// the StakePool accounts, polled every 15s. Isolated from useStakePoolBalances
// (which uses jsonParsed) so the working balances path is untouched.
//
// Reads Solana devnet via the same proxy (internal RPC only).

import { useEffect, useState } from 'react';
import type { Hex } from 'viem';
import { bytes32ToPublicKey } from './solana-pda';
import { readU64LE, stakePoolRate } from './stats-format';

const REFETCH_MS = 15_000;
const RPC = '/api/rpc/solana-devnet';

// SPL stake-pool struct (solana-program-library/stake-pool/.../state.rs):
//   total_lamports     u64 @ 258
//   pool_token_supply  u64 @ 266
const OFF_TOTAL_LAMPORTS = 258;
const OFF_POOL_TOKEN_SUPPLY = 266;

export type StakePoolStat = {
  totalLamports: bigint;
  poolTokenSupply: bigint;
  /** SOL per 1 LST (>1 — appreciates) and LST per 1 SOL. null until loaded. */
  rate: { lstPerSol: number; solPerLst: number } | null;
};

export type StakePoolStats = {
  /** keyed by pool-mint hex (matches registry entry.pool.poolMint). */
  byMint: Record<string, StakePoolStat>;
  loading: boolean;
};

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * @param pools  one {stakePool, poolMint} per pool (both bytes32 hex from the
 *               registry entry). stakePool = the StakePool account to decode.
 */
export function useStakePoolStats(
  pools: ReadonlyArray<{ stakePool: Hex; poolMint: Hex }>,
): StakePoolStats {
  const [stats, setStats] = useState<StakePoolStats>({ byMint: {}, loading: true });
  const key = pools.map((p) => p.stakePool).join('|');

  useEffect(() => {
    if (pools.length === 0) {
      setStats({ byMint: {}, loading: false });
      return;
    }
    let cancelled = false;

    const resolved = pools
      .map((p) => {
        try {
          return { poolMint: p.poolMint, addr: bytes32ToPublicKey(p.stakePool).toBase58() };
        } catch {
          return null;
        }
      })
      .filter((x): x is { poolMint: Hex; addr: string } => x !== null);

    const fetchOnce = async () => {
      try {
        const res = await fetch(RPC, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getMultipleAccounts',
            params: [resolved.map((r) => r.addr), { encoding: 'base64' }],
          }),
        });
        const json = await res.json();
        if (cancelled) return;
        const values = (json.result?.value ?? []) as Array<{ data?: [string, string] } | null>;
        const byMint: Record<string, StakePoolStat> = {};
        resolved.forEach((r, i) => {
          const raw = values[i]?.data?.[0];
          if (!raw) return;
          try {
            const bytes = b64ToBytes(raw);
            const totalLamports = readU64LE(bytes, OFF_TOTAL_LAMPORTS);
            const poolTokenSupply = readU64LE(bytes, OFF_POOL_TOKEN_SUPPLY);
            byMint[r.poolMint] = {
              totalLamports,
              poolTokenSupply,
              rate: stakePoolRate(totalLamports, poolTokenSupply),
            };
          } catch {
            /* skip undecodable account */
          }
        });
        setStats({ byMint, loading: false });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[cardo stake-pool-stats] fetch failed', e);
        setStats((prev) => ({ ...prev, loading: false }));
      }
    };

    fetchOnce();
    const id = setInterval(fetchOnce, REFETCH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return stats;
}
