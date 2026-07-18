// usePhoenixSwap — submit a Phoenix Swap (IOC market order) via Rome's
// CPI precompile.
//
// Single ix, signed by the user's Rome PDA. Caller passes the market
// entry + side selection + lot quantities. Receipt poll mirrors
// useRaydiumCpmmSwap (Rome's `useWaitForTransactionReceipt` is flaky).

import { useCallback, useState } from 'react';
import { useRomeWrite } from './use-rome-write';
import type { Address, Hex } from 'viem';
import { CPI_INVOKE_ABI, CPI_PRECOMPILE } from './cpi-precompile';
import { buildPhoenixSwapInvoke } from './phoenix-instructions';
import type { PhoenixMarketEntry } from './phoenix-markets';

export type PhoenixSwapPhase =
  | 'idle'
  | 'signing'
  | 'confirming'
  | 'success'
  | 'failed';

export type PhoenixSwapState = {
  phase: PhoenixSwapPhase;
  /// Which side the user spent.
  inputSide?: 'base' | 'quote';
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
      console.warn('[cardo phoenix-swap] receipt poll error', e);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`receipt poll timed out for ${hash}`);
}

export function usePhoenixSwap() {
  const [state, setState] = useState<PhoenixSwapState>({ phase: 'idle' });
  const { writeContractAsync } = useRomeWrite();

  const swap = useCallback(
    async (opts: {
      userEvmAddress: Address;
      market: PhoenixMarketEntry;
      inputIsBase: boolean;
      /// Input quantity in lot units (base lots if inputIsBase=true,
      /// quote lots otherwise).
      inputLots: bigint;
      /// Slippage guard in lot units of the OPPOSITE side.
      minOutputLots: bigint;
    }) => {
      const inputSide: 'base' | 'quote' = opts.inputIsBase ? 'base' : 'quote';
      setState({ phase: 'idle', inputSide });
      try {
        const built = buildPhoenixSwapInvoke(opts);
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
              'Phoenix swap reverted. Common causes: insufficient liquidity in the book, slippage guard tighter than realized fill, or input ATA balance below the requested base/quote lots.',
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
