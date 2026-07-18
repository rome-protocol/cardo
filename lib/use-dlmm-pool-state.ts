// Live Meteora DLMM pool state for the `/swap-dlmm` UI.
//
// Fetches the LbPair account + the two SPL vault accounts. Surfaces:
//   - active_id, bin_step, status                 for the bin-step quote
//   - base_factor, base_fee_power_factor          for the live fee rate
//   - reserve_x/y raw balances                    thin-pool warnings
//   - reserve_x/y effective balances              vault - protocol_fee
//   - protocol_share                              transparency
//
// Re-fetches on a fixed interval; safe to mount multiple instances.

import { useEffect, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import type { Hex } from 'viem';
import { decodeDlmmPool, computeBaseFeeRatePpb, type DlmmPool } from './dlmm-pools';

const RPC = '/api/rpc/solana-devnet';
const POLL_MS = 8_000;

export type DlmmPoolStateView = {
  pool: DlmmPool | null;
  /// Live token_x reserve balance (raw, includes accumulated protocol fees).
  reserveXRaw: bigint | null;
  /// Live token_y reserve balance (raw, includes accumulated protocol fees).
  reserveYRaw: bigint | null;
  /// Effective token_x reserve = vault - protocol_fee_x.
  reserveXEffective: bigint | null;
  /// Effective token_y reserve = vault - protocol_fee_y.
  reserveYEffective: bigint | null;
  /// Live `base_fee_rate` in parts-per-billion. Variable fee adds on
  /// top depending on volatility — UI reports base only for clarity.
  baseFeeRatePpb: bigint | null;
  loading: boolean;
  error?: string;
};

const EMPTY: DlmmPoolStateView = {
  pool: null,
  reserveXRaw: null,
  reserveYRaw: null,
  reserveXEffective: null,
  reserveYEffective: null,
  baseFeeRatePpb: null,
  loading: true,
};

function bs58FromHex(h: Hex): string {
  const clean = h.startsWith('0x') ? h.slice(2) : h;
  return new PublicKey(Buffer.from(clean, 'hex')).toBase58();
}

export function useDlmmPoolState(poolBs58: string | null): DlmmPoolStateView {
  const [state, setState] = useState<DlmmPoolStateView>(EMPTY);

  useEffect(() => {
    if (!poolBs58) {
      setState(EMPTY);
      return;
    }
    let cancelled = false;

    const tick = async () => {
      try {
        // 1) Pool account (raw, base64).
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
        const pool = decodeDlmmPool(buf);

        // 2) Both reserve balances in one batch.
        const xBs58 = bs58FromHex(pool.reserveX);
        const yBs58 = bs58FromHex(pool.reserveY);
        const r2 = await fetch(RPC, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getMultipleAccounts',
            params: [[xBs58, yBs58], { encoding: 'jsonParsed' }],
          }),
        });
        const j2 = await r2.json();
        const vs = j2?.result?.value || [];
        const xAmt: string | undefined =
          vs[0]?.data?.parsed?.info?.tokenAmount?.amount;
        const yAmt: string | undefined =
          vs[1]?.data?.parsed?.info?.tokenAmount?.amount;

        if (cancelled) return;
        const xRaw = xAmt ? BigInt(xAmt) : null;
        const yRaw = yAmt ? BigInt(yAmt) : null;
        const xEff = xRaw != null ? xRaw - pool.protocolFeeX : null;
        const yEff = yRaw != null ? yRaw - pool.protocolFeeY : null;
        const feePpb = computeBaseFeeRatePpb(
          pool.baseFactor,
          pool.binStep,
          pool.baseFeePowerFactor,
        );
        setState({
          pool,
          reserveXRaw: xRaw,
          reserveYRaw: yRaw,
          reserveXEffective: xEff,
          reserveYEffective: yEff,
          baseFeeRatePpb: feePpb,
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
