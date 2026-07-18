// Live Raydium AMM v4 pool state for the `/swap-raydium-amm` UI.
//
// Fetches the AmmInfo account + the two SPL vault accounts, surfaces the
// reserves + trade fee so the screen can compute a constant-product
// quote (`quoteRaydiumAmmV4SwapBaseIn`).
//
// Re-fetches on a fixed interval; safe to mount multiple instances.

import { useEffect, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import type { Hex } from 'viem';
import {
  decodeRaydiumAmmV4Pool,
  type RaydiumAmmV4Pool,
} from './raydium-amm-pools';

const RPC = '/api/rpc/solana-devnet';
const POLL_MS = 8_000;

export type RaydiumAmmV4PoolState = {
  pool: RaydiumAmmV4Pool | null;
  /// Live coin (token_0) vault balance (raw, includes accumulated PNL).
  coinReserve: bigint | null;
  /// Live pc (token_1) vault balance (raw).
  pcReserve: bigint | null;
  /// Effective coin reserve = vault - need_take_pnl_coin.
  /// Raydium's swap_base_in math nets out `need_take_pnl_*` before the
  /// constant-product calc. Quoting against raw vault overstates output.
  coinEffectiveReserve: bigint | null;
  /// Effective pc reserve = vault - need_take_pnl_pc.
  pcEffectiveReserve: bigint | null;
  loading: boolean;
  error?: string;
};

const EMPTY: RaydiumAmmV4PoolState = {
  pool: null,
  coinReserve: null,
  pcReserve: null,
  coinEffectiveReserve: null,
  pcEffectiveReserve: null,
  loading: true,
};

function bs58FromHex(h: Hex): string {
  const clean = h.startsWith('0x') ? h.slice(2) : h;
  return new PublicKey(Buffer.from(clean, 'hex')).toBase58();
}

export function useRaydiumAmmV4PoolState(
  poolBs58: string | null,
): RaydiumAmmV4PoolState {
  const [state, setState] = useState<RaydiumAmmV4PoolState>(EMPTY);

  useEffect(() => {
    if (!poolBs58) {
      setState(EMPTY);
      return;
    }
    let cancelled = false;

    const tick = async () => {
      try {
        // 1) Pool AmmInfo (raw, base64).
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
        const pool = decodeRaydiumAmmV4Pool(buf);

        // 2) Both vault balances (jsonParsed).
        const cBs58 = bs58FromHex(pool.coinVault);
        const pBs58 = bs58FromHex(pool.pcVault);
        const r2 = await fetch(RPC, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getMultipleAccounts',
            params: [
              [cBs58, pBs58],
              { encoding: 'jsonParsed' },
            ],
          }),
        });
        const j2 = await r2.json();
        const vs = j2?.result?.value || [];
        const cAmt: string | undefined =
          vs[0]?.data?.parsed?.info?.tokenAmount?.amount;
        const pAmt: string | undefined =
          vs[1]?.data?.parsed?.info?.tokenAmount?.amount;

        if (cancelled) return;
        const cRaw = cAmt ? BigInt(cAmt) : null;
        const pRaw = pAmt ? BigInt(pAmt) : null;
        const cEff =
          cRaw != null
            ? cRaw - pool.needTakePnlCoin
            : null;
        const pEff =
          pRaw != null
            ? pRaw - pool.needTakePnlPc
            : null;
        setState({
          pool,
          coinReserve: cRaw,
          pcReserve: pRaw,
          coinEffectiveReserve: cEff,
          pcEffectiveReserve: pEff,
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
