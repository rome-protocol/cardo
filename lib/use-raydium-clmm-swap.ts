// useRaydiumClmmSwap — submit a Raydium CLMM swap_v2 via Rome's
// CPI precompile.
//
// Single ix, signed by the user's Rome PDA. Caller passes the registry
// pool entry + side selection + amounts. Receipt poll mirrors
// useRaydiumCpmmSwap / usePumpswapSwap (Rome's
// `useWaitForTransactionReceipt` has been flaky per playbook §4.10).

import { useCallback, useState } from 'react';
import { useRomeWrite } from './use-rome-write';
import type { Address, Hex } from 'viem';
import { CPI_INVOKE_ABI, CPI_PRECOMPILE } from './cpi-precompile';
import { buildRaydiumClmmSwapV2Invoke } from './raydium-clmm-instructions';
import type { RaydiumClmmPoolEntry } from './raydium-clmm-pools';

export type RaydiumClmmSwapPhase =
  | 'idle'
  | 'signing'
  | 'confirming'
  | 'success'
  | 'failed';

export type RaydiumClmmSwapState = {
  phase: RaydiumClmmSwapPhase;
  /// 'token0' or 'token1' — which side the user spent.
  inputSide?: 'token0' | 'token1';
  hash?: Hex;
  error?: string;
};

const POLL_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 2_000;

async function waitForReceipt(
  hash: Hex,
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
        return {
          status: json.result.status === '0x1' ? 'success' : 'reverted',
        };
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[cardo raydium-clmm-swap] receipt poll error', e);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`receipt poll timed out for ${hash}`);
}

export function useRaydiumClmmSwap() {
  const [state, setState] = useState<RaydiumClmmSwapState>({ phase: 'idle' });
  const { writeContractAsync } = useRomeWrite();

  const swap = useCallback(
    async (opts: {
      userEvmAddress: Address;
      pool: RaydiumClmmPoolEntry;
      inputIsToken0: boolean;
      amountIn: bigint;
      minimumAmountOut: bigint;
      /// Live pool tick_current (from pool state) — picks the correct tick
      /// array for the current price instead of a stale static seed.
      tickCurrent?: number;
    }) => {
      const inputSide = opts.inputIsToken0 ? 'token0' : 'token1';
      setState({ phase: 'idle', inputSide });
      try {
        const built = buildRaydiumClmmSwapV2Invoke(opts);
        setState({ phase: 'signing', inputSide });
        const hash = await writeContractAsync({
          address: CPI_PRECOMPILE,
          abi: CPI_INVOKE_ABI,
          functionName: 'invoke',
          args: [built.program, built.accounts, built.data],
        });
        setState({ phase: 'confirming', inputSide, hash });
        const r = await waitForReceipt(hash);
        if (r.status === 'reverted') {
          setState({
            phase: 'failed',
            inputSide,
            hash,
            error:
              'Raydium CLMM swap reverted. Common causes: thin liquidity in current tick array, current tick crossed an initialized boundary needing a tick array we did not pass, slippage guard exceeded, or pool status disabled swaps.',
          });
          return;
        }
        setState({ phase: 'success', inputSide, hash });
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
