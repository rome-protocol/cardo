// useDammV2PoolState — read pool's liquidity (u128 at offset 360) and
// sqrt_price (u128 at offset 456) for a quote-preview / health check.
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md

import { useEffect, useState } from 'react';
import { bytes32ToPublicKey } from './solana-pda';
import type { DammV2Pool } from './damm-v2-pools';

const REFRESH_MS = 8_000;
const RPC = '/api/rpc/solana-devnet';

export type DammV2PoolState = {
  liquidity?: bigint;
  sqrtPriceX64?: bigint;
  loading: boolean;
};

export function useDammV2PoolState(pool: DammV2Pool | undefined): DammV2PoolState {
  const [state, setState] = useState<DammV2PoolState>({ loading: true });

  useEffect(() => {
    if (!pool) {
      setState({ loading: false });
      return;
    }
    let cancelled = false;
    const poolBs58 = bytes32ToPublicKey(pool.pool).toBase58();

    const run = async () => {
      try {
        // Slice from offset 360 to 472 (covers liquidity + padding_1 +
        // protocol_a_fee + protocol_b_fee + padding_2 + sqrt_min_price +
        // sqrt_max_price + sqrt_price = 16+16+8+8+16+16+16+16 = 112 bytes).
        const res = await fetch(RPC, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getAccountInfo',
            params: [
              poolBs58,
              { encoding: 'base64', dataSlice: { offset: 360, length: 112 } },
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
        // 0..16: liquidity (u128 LE)
        const liquidity =
          buf.readBigUInt64LE(0) | (buf.readBigUInt64LE(8) << 64n);
        // 96..112: sqrt_price (u128 LE) — offset 96 within slice = 360+96 = 456 absolute
        const sqrtPrice =
          buf.readBigUInt64LE(96) | (buf.readBigUInt64LE(104) << 64n);
        setState({ liquidity, sqrtPriceX64: sqrtPrice, loading: false });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[cardo damm-v2-pool] fetch failed', e);
        if (!cancelled) setState((p) => ({ ...p, loading: false }));
      }
    };

    void run();
    const id = setInterval(run, REFRESH_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [pool]);

  return state;
}
