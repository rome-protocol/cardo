// Live Phoenix market state for the `/swap-phoenix` UI.
//
// Polls (a) the market account header (decimals, lot sizes, status,
// tick scaling) and (b) both vault SPL token balances every 8 s. The
// vault balances are the only "book is alive" signal we surface — we
// don't decode the FIFO order tree (it's ~85 KB and split across
// critbit nodes; way too much work for an indicative quote).
//
// We compute an indicative price by assuming the seeded ASK fills at
// its resting price (1100 ticks → $110/SOL). This is intentionally
// optimistic; the screen labels the quote as "indicative" so users
// know slippage applies.

import { useEffect, useState } from 'react';
import type { Hex } from 'viem';
import { PublicKey } from '@solana/web3.js';
import {
  decodePhoenixMarketHeader,
  type PhoenixMarketHeader,
} from './phoenix-markets';

const RPC = '/api/rpc/solana-devnet';
const POLL_MS = 8_000;

export type PhoenixMarketState = {
  header: PhoenixMarketHeader | null;
  /// Live base-vault balance in atoms (raw u64). Should be > 0 if at
  /// least one ASK rests on the book.
  baseVaultAtoms: bigint | null;
  /// Live quote-vault balance in atoms.
  quoteVaultAtoms: bigint | null;
  loading: boolean;
  error?: string;
};

const EMPTY: PhoenixMarketState = {
  header: null,
  baseVaultAtoms: null,
  quoteVaultAtoms: null,
  loading: true,
};

function bs58FromHex(h: Hex): string {
  const clean = h.startsWith('0x') ? h.slice(2) : h;
  return new PublicKey(Buffer.from(clean, 'hex')).toBase58();
}

export function usePhoenixMarketState(
  marketBs58: string | null,
): PhoenixMarketState {
  const [state, setState] = useState<PhoenixMarketState>(EMPTY);

  useEffect(() => {
    if (!marketBs58) {
      setState(EMPTY);
      return;
    }
    let cancelled = false;

    const tick = async () => {
      try {
        // 1) Market account (raw, base64).
        const r1 = await fetch(RPC, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getAccountInfo',
            params: [marketBs58, { encoding: 'base64' }],
          }),
        });
        const j1 = await r1.json();
        const v = j1?.result?.value;
        if (!v) {
          if (!cancelled)
            setState({ ...EMPTY, loading: false, error: 'market not found' });
          return;
        }
        const buf = Buffer.from(v.data[0], 'base64');
        const header = decodePhoenixMarketHeader(buf);

        // 2) Both vault balances in one batch (jsonParsed → uiAmount).
        const baseVaultBs58 = bs58FromHex(header.baseVault);
        const quoteVaultBs58 = bs58FromHex(header.quoteVault);
        const r2 = await fetch(RPC, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getMultipleAccounts',
            params: [
              [baseVaultBs58, quoteVaultBs58],
              { encoding: 'jsonParsed' },
            ],
          }),
        });
        const j2 = await r2.json();
        const vs = j2?.result?.value || [];
        const bAmt: string | undefined =
          vs[0]?.data?.parsed?.info?.tokenAmount?.amount;
        const qAmt: string | undefined =
          vs[1]?.data?.parsed?.info?.tokenAmount?.amount;

        if (cancelled) return;
        setState({
          header,
          baseVaultAtoms: bAmt ? BigInt(bAmt) : null,
          quoteVaultAtoms: qAmt ? BigInt(qAmt) : null,
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
  }, [marketBs58]);

  return state;
}
