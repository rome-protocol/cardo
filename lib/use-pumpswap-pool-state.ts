// Live PumpSwap pool state for the `/swap-pumpswap` UI.
//
// Fetches the Pool account + the two SPL vault accounts, decodes them,
// and surfaces the reserves so the screen can compute a constant-product
// quote (`quotePumpSwapBuy`/`quotePumpSwapSell`).
//
// Re-fetches on a fixed interval; safe to mount multiple instances.

import { useEffect, useState } from 'react';
import {
  decodePumpSwapPool,
  type PumpSwapPool,
} from './pumpswap-pools';

const RPC = '/api/rpc/solana-devnet';
const POLL_MS = 8_000;

export type PumpswapPoolState = {
  /// Decoded Pool struct (or null while loading / on error).
  pool: PumpSwapPool | null;
  /// Live base vault balance (raw, no decimal scaling).
  baseReserve: bigint | null;
  /// Live quote vault balance (raw).
  quoteReserve: bigint | null;
  loading: boolean;
  error?: string;
};

const EMPTY: PumpswapPoolState = {
  pool: null,
  baseReserve: null,
  quoteReserve: null,
  loading: true,
};

export function usePumpswapPoolState(poolBs58: string | null): PumpswapPoolState {
  const [state, setState] = useState<PumpswapPoolState>(EMPTY);

  useEffect(() => {
    if (!poolBs58) {
      setState(EMPTY);
      return;
    }
    let cancelled = false;

    const tick = async () => {
      try {
        // 1) Fetch the Pool account (raw, base64).
        const r1 = await fetch(RPC, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getAccountInfo',
            params: [poolBs58, { encoding: 'base64' }],
          }),
        });
        const j1 = await r1.json();
        const v = j1?.result?.value;
        if (!v) {
          if (!cancelled)
            setState({ ...EMPTY, loading: false, error: 'pool not found' });
          return;
        }
        const buf = Buffer.from(v.data[0], 'base64');
        const pool = decodePumpSwapPool(buf);

        // 2) Fetch both vault balances in one call.
        const baseAtaBs58 = bs58FromHex(pool.poolBaseTokenAccount);
        const quoteAtaBs58 = bs58FromHex(pool.poolQuoteTokenAccount);
        const r2 = await fetch(RPC, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getMultipleAccounts',
            params: [
              [baseAtaBs58, quoteAtaBs58],
              { encoding: 'jsonParsed' },
            ],
          }),
        });
        const j2 = await r2.json();
        const vs = j2?.result?.value || [];
        const baseAmt: string | undefined =
          vs[0]?.data?.parsed?.info?.tokenAmount?.amount;
        const quoteAmt: string | undefined =
          vs[1]?.data?.parsed?.info?.tokenAmount?.amount;
        if (cancelled) return;
        setState({
          pool,
          baseReserve: baseAmt ? BigInt(baseAmt) : null,
          quoteReserve: quoteAmt ? BigInt(quoteAmt) : null,
          loading: false,
        });
      } catch (e) {
        if (!cancelled)
          setState({
            ...EMPTY,
            loading: false,
            error: (e as Error).message ?? String(e),
          });
      }
    };

    void tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [poolBs58]);

  return state;
}

// Local helper — convert our 0x… bytes32 hex back to bs58 for RPC calls.
// Avoids pulling @solana/web3.js into this module's runtime path until
// the effect actually fires (not a real win on bundle, but keeps imports
// minimal at the call site).
import { PublicKey } from '@solana/web3.js';
import type { Hex } from 'viem';
function bs58FromHex(h: Hex): string {
  const clean = h.startsWith('0x') ? h.slice(2) : h;
  return new PublicKey(Buffer.from(clean, 'hex')).toBase58();
}
