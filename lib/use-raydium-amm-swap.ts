// useRaydiumAmmV4Swap — submit a Raydium AMM v4 swap_base_in via Rome's
// CPI precompile.
//
// Single ix, signed by the user's Rome PDA. Caller passes the registry
// pool entry + side selection + amounts. Receipt poll mirrors
// useRaydiumCpmmSwap (Rome's `useWaitForTransactionReceipt` is flaky
// per playbook §4.10).

import { useCallback, useState } from 'react';
import { useRomeWrite } from './use-rome-write';
import type { Address, Hex } from 'viem';
import { CPI_INVOKE_ABI, CPI_PRECOMPILE } from './cpi-precompile';
import { buildRaydiumAmmV4SwapBaseInInvoke } from './raydium-amm-instructions';
import type { RaydiumAmmV4PoolEntry } from './raydium-amm-pools';

export type RaydiumAmmV4SwapPhase =
  | 'idle'
  | 'signing'
  | 'confirming'
  | 'success'
  | 'failed';

export type RaydiumAmmV4SwapState = {
  phase: RaydiumAmmV4SwapPhase;
  /// 'coin' (token_0) or 'pc' (token_1) — which side the user spent.
  inputSide?: 'coin' | 'pc';
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
      console.warn('[cardo raydium-amm-v4-swap] receipt poll error', e);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`receipt poll timed out for ${hash}`);
}

export function useRaydiumAmmV4Swap() {
  const [state, setState] = useState<RaydiumAmmV4SwapState>({ phase: 'idle' });
  const { writeContractAsync } = useRomeWrite();

  const swap = useCallback(
    async (opts: {
      userEvmAddress: Address;
      pool: RaydiumAmmV4PoolEntry;
      inputIsCoin: boolean;
      amountIn: bigint;
      minimumAmountOut: bigint;
    }) => {
      const inputSide = opts.inputIsCoin ? 'coin' : 'pc';
      setState({ phase: 'idle', inputSide });
      try {
        const built = buildRaydiumAmmV4SwapBaseInInvoke(opts);
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
              'Raydium AMM v4 swap reverted. Common causes: pool reserves drifted past your slippage guard, pool status flag disables swap, insufficient input ATA balance, or serum/openbook market state stale.',
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
