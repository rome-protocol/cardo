// useDlmmSwap — submit a Meteora DLMM `swap` invoke via Rome's CPI
// precompile.
//
// Single ix, signed by the user's Rome PDA. Caller passes the registry
// pool entry + side selection + amounts. Receipt poll mirrors
// useRaydiumClmmSwap (Rome's `useWaitForTransactionReceipt` has been
// flaky per playbook §4.10).

import { useCallback, useState } from 'react';
import { useRomeWrite } from './use-rome-write';
import type { Address, Hex } from 'viem';
import { CPI_INVOKE_ABI, CPI_PRECOMPILE } from './cpi-precompile';
import { buildDlmmSwapInvoke } from './dlmm-instructions';
import type { DlmmPoolEntry } from './dlmm-pools';

export type DlmmSwapPhase =
  | 'idle'
  | 'signing'
  | 'confirming'
  | 'success'
  | 'failed';

export type DlmmSwapState = {
  phase: DlmmSwapPhase;
  /// 'x' or 'y' — which side the user spent.
  inputSide?: 'x' | 'y';
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
      console.warn('[cardo dlmm-swap] receipt poll error', e);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`receipt poll timed out for ${hash}`);
}

export function useDlmmSwap() {
  const [state, setState] = useState<DlmmSwapState>({ phase: 'idle' });
  const { writeContractAsync } = useRomeWrite();

  const swap = useCallback(
    async (opts: {
      userEvmAddress: Address;
      pool: DlmmPoolEntry;
      swapXForY: boolean;
      amountIn: bigint;
      minimumAmountOut: bigint;
    }) => {
      const inputSide: 'x' | 'y' = opts.swapXForY ? 'x' : 'y';
      setState({ phase: 'idle', inputSide });
      try {
        const built = buildDlmmSwapInvoke(opts);
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
              'DLMM swap reverted. Common causes: thin liquidity in active bin, swap traverses an uninitialized bin array we did not include, slippage guard exceeded, pool status disabled swaps, or the active_id moved since quote was computed.',
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
