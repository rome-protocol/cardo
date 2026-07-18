// useOrcaPoolState — read whirlpool current_tick + sqrt_price + liquidity
// from devnet, polling every 8s. Required so the swap adapter can
// derive the correct tick_array PDAs at submit time.
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md
// (Family 3 — Orca Whirlpool swap).

import { useEffect, useState } from 'react';
import { bytes32ToPublicKey } from './solana-pda';
import type { OrcaPool } from './orca-pools';

const REFRESH_MS = 8_000;
const RPC = '/api/rpc/solana-devnet';

export type OrcaPoolState = {
  /// Whirlpool current tick. Required input to the swap builder.
  currentTick?: number;
  /// sqrt_price * 2^64 (u128). Useful for quote math.
  sqrtPriceX64?: bigint;
  /// Whirlpool active liquidity (u128). 0 means no swappable depth at
  /// the current price; UI should disable submit.
  liquidity?: bigint;
  loading: boolean;
};

export function useOrcaPoolState(pool: OrcaPool | undefined): OrcaPoolState {
  const [state, setState] = useState<OrcaPoolState>({ loading: true });

  useEffect(() => {
    if (!pool) {
      setState({ loading: false });
      return;
    }
    let cancelled = false;
    const whirlpoolBs58 = bytes32ToPublicKey(pool.whirlpool).toBase58();

    const run = async () => {
      try {
        const res = await fetch(RPC, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getAccountInfo',
            params: [
              whirlpoolBs58,
              { encoding: 'base64', dataSlice: { offset: 49, length: 36 } },
            ],
          }),
        });
        const json = await res.json();
        if (cancelled) return;
        const value = json.result?.value;
        if (!value) {
          setState({ loading: false });
          return;
        }
        const buf = Buffer.from(value.data[0], 'base64');
        // 49: liquidity (16) | 65: sqrt_price (16) | 81: tick_current_index (4 i32 LE)
        const liquidity = buf.readBigUInt64LE(0) | (buf.readBigUInt64LE(8) << 64n);
        const sqrtPrice =
          buf.readBigUInt64LE(16) | (buf.readBigUInt64LE(24) << 64n);
        const tick = buf.readInt32LE(32);
        setState({
          currentTick: tick,
          sqrtPriceX64: sqrtPrice,
          liquidity,
          loading: false,
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[cardo orca-pool] fetch failed', e);
        if (!cancelled) setState((p) => ({ ...p, loading: false }));
      }
    };

    void run();
    const id = setInterval(run, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pool]);

  return state;
}
