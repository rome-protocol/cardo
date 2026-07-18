// useBondingCurve — fetch + decode the BondingCurve account for a
// given memecoin mint, polling at 8s.

import { useEffect, useState } from 'react';
import type { Hex } from 'viem';
import {
  bytes32ToPublicKey,
} from './solana-pda';
import { decodeBondingCurve, type BondingCurve } from './pumpfun-curves';
import { deriveBondingCurve } from './pumpfun-pdas';

const RPC = '/api/rpc/solana-devnet';
const POLL_MS = 8_000;

export type BondingCurveState = {
  loading: boolean;
  curve: BondingCurve | null;
  curveBs58?: string;
  error?: string;
};

export function useBondingCurve(mintHex: Hex | null): BondingCurveState {
  const [state, setState] = useState<BondingCurveState>({
    loading: true,
    curve: null,
  });

  useEffect(() => {
    if (!mintHex) {
      setState({ loading: false, curve: null });
      return;
    }
    let cancelled = false;
    let curveHex: Hex;
    let curveBs58: string;
    try {
      curveHex = deriveBondingCurve(mintHex);
      curveBs58 = bytes32ToPublicKey(curveHex).toBase58();
    } catch (e) {
      setState({
        loading: false,
        curve: null,
        error: (e as Error).message ?? String(e),
      });
      return;
    }
    setState({ loading: true, curve: null, curveBs58 });

    const tick = async () => {
      try {
        const res = await fetch(RPC, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getAccountInfo',
            params: [curveBs58, { encoding: 'base64' }],
          }),
        });
        const json = await res.json();
        if (cancelled) return;
        const v = json?.result?.value;
        if (!v) {
          setState({
            loading: false,
            curve: null,
            curveBs58,
            error: 'bonding curve not found for this mint',
          });
          return;
        }
        const buf = Buffer.from(v.data[0], 'base64');
        const curve = decodeBondingCurve(buf, curveHex);
        setState({ loading: false, curve, curveBs58 });
      } catch (e) {
        if (!cancelled)
          setState({
            loading: false,
            curve: null,
            curveBs58,
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
  }, [mintHex]);

  return state;
}
