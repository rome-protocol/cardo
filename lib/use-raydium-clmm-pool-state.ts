// Live Raydium CLMM pool state for the `/swap-raydium-clmm` UI.
//
// Fetches the PoolState account + the two SPL vault accounts + the
// AmmConfig (trade fee). Surfaces:
//   - liquidity, sqrt_price_x64, tick_current        for the CL quote
//   - fee_rate_ppm                                    fee schedule
//   - vault0/1 raw balances                           thin-pool warnings
//   - vault0/1 effective balances (vault - protocolFee - fundFee)
//
// Re-fetches on a fixed interval; safe to mount multiple instances.

import { useEffect, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import type { Hex } from 'viem';
import {
  decodeRaydiumClmmPool,
  type RaydiumClmmPool,
} from './raydium-clmm-pools';

const RPC = '/api/rpc/solana-devnet';
const POLL_MS = 8_000;

export type RaydiumClmmPoolState = {
  pool: RaydiumClmmPool | null;
  /// Live token_0 vault balance (raw, includes accumulated fees).
  /// Used for thin-pool warnings; the swap math uses sqrt_price_x64 +
  /// liquidity, not vault balances.
  token0Reserve: bigint | null;
  /// Live token_1 vault balance (raw, includes accumulated fees).
  token1Reserve: bigint | null;
  /// Effective token_0 reserve = vault - protocolFee_t0 - fundFee_t0.
  /// What's actually swappable out of the pool — anything above eats
  /// into reserved fees and the program reverts.
  token0EffectiveReserve: bigint | null;
  /// Effective token_1 reserve = vault - protocolFee_t1 - fundFee_t1.
  token1EffectiveReserve: bigint | null;
  /// AmmConfig.trade_fee_rate (parts-per-million; 100 = 1 bp · 10000 = 1%).
  /// Live HXAQnU2 pool's AmmConfig reports 500 → 5 bps.
  tradeFeeRatePpm: bigint | null;
  loading: boolean;
  error?: string;
};

const EMPTY: RaydiumClmmPoolState = {
  pool: null,
  token0Reserve: null,
  token1Reserve: null,
  token0EffectiveReserve: null,
  token1EffectiveReserve: null,
  tradeFeeRatePpm: null,
  loading: true,
};

function bs58FromHex(h: Hex): string {
  const clean = h.startsWith('0x') ? h.slice(2) : h;
  return new PublicKey(Buffer.from(clean, 'hex')).toBase58();
}

export function useRaydiumClmmPoolState(
  poolBs58: string | null,
): RaydiumClmmPoolState {
  const [state, setState] = useState<RaydiumClmmPoolState>(EMPTY);

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
        const pool = decodeRaydiumClmmPool(buf);

        // 2) Both vault balances + the AmmConfig in one batch.
        const v0Bs58 = bs58FromHex(pool.token0Vault);
        const v1Bs58 = bs58FromHex(pool.token1Vault);
        const ammBs58 = bs58FromHex(pool.ammConfig);
        const r2 = await fetch(RPC, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getMultipleAccounts',
            params: [
              [v0Bs58, v1Bs58, ammBs58],
              { encoding: 'jsonParsed' },
            ],
          }),
        });
        const j2 = await r2.json();
        const vs = j2?.result?.value || [];
        const v0Amt: string | undefined =
          vs[0]?.data?.parsed?.info?.tokenAmount?.amount;
        const v1Amt: string | undefined =
          vs[1]?.data?.parsed?.info?.tokenAmount?.amount;

        // CLMM AmmConfig comes back unparsed. Re-fetch base64 and read
        // `trade_fee_rate` at offset 47..51 (u32 LE):
        //   8 disc + 1 bump + 2 index + 32 owner + 4 protocol_fee_rate
        //   = 47 bytes, then trade_fee_rate u32.
        const r3 = await fetch(RPC, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getAccountInfo',
            params: [ammBs58, { encoding: 'base64' }],
          }),
        });
        const j3 = await r3.json();
        const ammVal = j3?.result?.value;
        let feeRatePpm: bigint | null = null;
        if (ammVal?.data?.[0]) {
          const ammBuf = Buffer.from(ammVal.data[0], 'base64');
          if (ammBuf.length >= 51) {
            feeRatePpm = BigInt(ammBuf.readUInt32LE(47));
          }
        }

        if (cancelled) return;
        const t0Raw = v0Amt ? BigInt(v0Amt) : null;
        const t1Raw = v1Amt ? BigInt(v1Amt) : null;
        const t0Eff =
          t0Raw != null
            ? t0Raw - pool.protocolFeesToken0 - pool.fundFeesToken0
            : null;
        const t1Eff =
          t1Raw != null
            ? t1Raw - pool.protocolFeesToken1 - pool.fundFeesToken1
            : null;
        setState({
          pool,
          token0Reserve: t0Raw,
          token1Reserve: t1Raw,
          token0EffectiveReserve: t0Eff,
          token1EffectiveReserve: t1Eff,
          tradeFeeRatePpm: feeRatePpm,
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
