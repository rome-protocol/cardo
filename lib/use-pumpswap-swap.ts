// usePumpswapSwap — submit a PumpSwap buy or sell via Rome's CPI
// precompile.
//
// Single ix per submission, signed by the user's Rome PDA. Caller picks
// the side ('buy' | 'sell') and passes amounts + the decoded Pool struct.
// Receipt poll mirrors use-orca-swap.
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md

import { useCallback, useState } from 'react';
import { useRomeWrite } from './use-rome-write';
import type { Address, Hex } from 'viem';
import { CPI_INVOKE_ABI, CPI_PRECOMPILE } from './cpi-precompile';
import {
  buildPumpSwapBuyInvoke,
  buildPumpSwapSellInvoke,
} from './pumpswap-instructions';
import type { PumpSwapPool } from './pumpswap-pools';

export type PumpSwapPhase =
  | 'idle'
  | 'signing'
  | 'confirming'
  | 'success'
  | 'failed';

export type PumpSwapState = {
  phase: PumpSwapPhase;
  side?: 'buy' | 'sell';
  hash?: `0x${string}`;
  error?: string;
};

const POLL_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 2_000;

async function waitForReceipt(
  hash: `0x${string}`,
): Promise<{ status: 'success' | 'reverted' }> {
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    try {
      const res = await fetch('/api/rpc/rome', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_getTransactionReceipt',
          params: [hash],
        }),
      });
      const json = await res.json();
      if (json.result?.blockNumber) {
        return { status: json.result.status === '0x1' ? 'success' : 'reverted' };
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[cardo pumpswap-swap] receipt poll error', e);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`receipt poll timed out for ${hash}`);
}

type SwapArgs =
  | {
      side: 'buy';
      userEvmAddress: Address;
      pool: PumpSwapPool;
      poolPubkey: string;
      baseAmountOut: bigint;
      maxQuoteAmountIn: bigint;
      trackVolume?: boolean;
    }
  | {
      side: 'sell';
      userEvmAddress: Address;
      pool: PumpSwapPool;
      poolPubkey: string;
      baseAmountIn: bigint;
      minQuoteAmountOut: bigint;
    };

export function usePumpswapSwap() {
  const [state, setState] = useState<PumpSwapState>({ phase: 'idle' });
  const { writeContractAsync } = useRomeWrite();

  const swap = useCallback(
    async (args: SwapArgs) => {
      setState({ phase: 'idle', side: args.side });
      try {
        const built =
          args.side === 'buy'
            ? buildPumpSwapBuyInvoke(args)
            : buildPumpSwapSellInvoke(args);

        setState({ phase: 'signing', side: args.side });
        const hash = await writeContractAsync({
          address: CPI_PRECOMPILE,
          abi: CPI_INVOKE_ABI,
          functionName: 'invoke',
          args: [built.program, built.accounts, built.data],
        });
        setState({ phase: 'confirming', side: args.side, hash });
        const r = await waitForReceipt(hash);
        if (r.status === 'reverted') {
          setState({
            phase: 'failed',
            side: args.side,
            hash,
            error:
              "PumpSwap " +
              args.side +
              " reverted. Common causes: pool reserves drifted past your slippage guard, insufficient ATA balance, or pool is in mayhem mode.",
          });
          return;
        }
        setState({ phase: 'success', side: args.side, hash });
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        setState((prev) => ({ ...prev, phase: 'failed', error: msg }));
      }
    },
    [writeContractAsync],
  );

  const reset = useCallback(() => setState({ phase: 'idle' }), []);

  return { state, swap, reset } as const;
}

/// Minimal helper: convenience overload to derive the user-facing
/// account list (without submitting). Handy for previews, debugging, and
/// the discovery script in scripts/probe-pumpswap-pools.mjs.
export function previewPumpSwapInvoke(args: SwapArgs): {
  program: Hex;
  accountCount: number;
} {
  const built =
    args.side === 'buy'
      ? buildPumpSwapBuyInvoke(args)
      : buildPumpSwapSellInvoke(args);
  return { program: built.program, accountCount: built.accounts.length };
}
