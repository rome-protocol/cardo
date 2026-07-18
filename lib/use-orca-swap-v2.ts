// useOrcaSwapV2 — submit Orca Whirlpool swap_v2 via Rome's CPI precompile.
// Token-2022-aware variant of the existing useOrcaSwap. Same args, same
// poll pattern; different ix (15 accounts vs 11) for support of
// Token-2022 mints + transfer-hook routing through Memo program.

import { useCallback, useState } from 'react';
import { useRomeWrite } from './use-rome-write';
import type { Address, Hex } from 'viem';
import { CPI_INVOKE_ABI, CPI_PRECOMPILE } from './cpi-precompile';
import { buildOrcaSwapV2Invoke } from './orca-instructions';
import type { OrcaPool } from './orca-pools';

export type OrcaSwapV2Phase =
  | 'idle'
  | 'signing'
  | 'confirming'
  | 'success'
  | 'failed';

export type OrcaSwapV2State = {
  phase: OrcaSwapV2Phase;
  label?: string;
  amount?: bigint;
  hash?: Hex;
  error?: string;
};

const POLL_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 2_000;

async function waitForReceipt(hash: Hex): Promise<{ status: 'success' | 'reverted' }> {
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
      console.warn('[cardo orca-swap-v2] receipt poll error', e);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`receipt poll timed out for ${hash}`);
}

export function useOrcaSwapV2() {
  const [state, setState] = useState<OrcaSwapV2State>({ phase: 'idle' });
  const { writeContractAsync } = useRomeWrite();

  const swap = useCallback(
    async (opts: {
      userEvmAddress: Address;
      pool: OrcaPool;
      currentTick: number;
      aToB: boolean;
      amount: bigint;
      otherAmountThreshold: bigint;
      label?: string;
      tokenProgramAHex?: Hex;
      tokenProgramBHex?: Hex;
    }) => {
      setState({ phase: 'idle', label: opts.label, amount: opts.amount });
      try {
        const built = buildOrcaSwapV2Invoke(opts);
        setState({ phase: 'signing', label: opts.label, amount: opts.amount });
        const hash = await writeContractAsync({
          address: CPI_PRECOMPILE,
          abi: CPI_INVOKE_ABI,
          functionName: 'invoke',
          args: [built.program, built.accounts, built.data],
        });
        setState({ phase: 'confirming', label: opts.label, amount: opts.amount, hash });
        const r = await waitForReceipt(hash);
        if (r.status === 'reverted') {
          setState({
            phase: 'failed',
            label: opts.label,
            amount: opts.amount,
            hash,
            error:
              'swap_v2 reverted. Common causes: pool reserves drifted past your slippage guard, mint has a transfer hook we did not pass, or pool is paused.',
          });
          return;
        }
        setState({ phase: 'success', label: opts.label, amount: opts.amount, hash });
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
