// useDammV2Swap — submit a Meteora DAMM v2 swap via Rome's CPI precompile.
// Single ix, 14 accounts, single signer (the user's Rome PDA).
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md

import { useCallback, useState } from 'react';
import { useRomeWrite } from './use-rome-write';
import type { Address } from 'viem';
import { CPI_PRECOMPILE, CPI_INVOKE_ABI } from './cpi-precompile';
import { buildDammV2SwapInvoke } from './damm-v2-instructions';
import type { DammV2Pool } from './damm-v2-pools';

export type DammV2SwapPhase =
  | 'idle'
  | 'signing'
  | 'confirming'
  | 'success'
  | 'failed';

export type DammV2SwapState = {
  phase: DammV2SwapPhase;
  label?: string;
  amount?: bigint;
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
      console.warn('[cardo damm-v2-swap] receipt poll error', e);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`receipt poll timed out for ${hash}`);
}

export function useDammV2Swap() {
  const [state, setState] = useState<DammV2SwapState>({ phase: 'idle' });
  const { writeContractAsync } = useRomeWrite();

  const swap = useCallback(
    async (opts: {
      userEvmAddress: Address;
      pool: DammV2Pool;
      aToB: boolean;
      amountIn: bigint;
      minimumAmountOut: bigint;
      label: string;
    }) => {
      setState({ phase: 'idle', label: opts.label, amount: opts.amountIn });
      try {
        const { program, accounts, data } = buildDammV2SwapInvoke({
          userEvmAddress: opts.userEvmAddress,
          pool: opts.pool,
          aToB: opts.aToB,
          amountIn: opts.amountIn,
          minimumAmountOut: opts.minimumAmountOut,
        });
        setState({ phase: 'signing', label: opts.label, amount: opts.amountIn });
        const hash = await writeContractAsync({
          address: CPI_PRECOMPILE,
          abi: CPI_INVOKE_ABI,
          functionName: 'invoke',
          args: [program, accounts, data],
        });
        setState({
          phase: 'confirming',
          label: opts.label,
          amount: opts.amountIn,
          hash,
        });
        const r = await waitForReceipt(hash);
        if (r.status === 'reverted') {
          setState({
            phase: 'failed',
            label: opts.label,
            amount: opts.amountIn,
            hash,
            error: 'DAMM v2 swap reverted on-chain.',
          });
          return;
        }
        setState({
          phase: 'success',
          label: opts.label,
          amount: opts.amountIn,
          hash,
        });
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        setState((prev) => ({ ...prev, phase: 'failed', error: msg }));
      }
    },
    [writeContractAsync],
  );

  const reset = useCallback(() => setState({ phase: 'idle' }), []);

  return { state, swap, reset };
}
