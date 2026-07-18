// useMarinadeDeposit — submit a Marinade `deposit(lamports)` via Rome's
// CPI precompile.
//
// Single ix, signed by the user's Rome PDA. Caller passes the live
// State-derived msol_mint + msol_leg + amount. Receipt poll mirrors
// useRaydiumCpmmSwap (Rome's `useWaitForTransactionReceipt` is
// flaky per playbook §4.10).

import { useCallback, useState } from 'react';
import type { Address, Hex } from 'viem';
import { useRomeWrite } from './use-rome-write';
import { CPI_INVOKE_ABI, CPI_PRECOMPILE } from './cpi-precompile';
import { buildMarinadeDepositInvoke } from './marinade-instructions';

export type MarinadeDepositPhase =
  | 'idle'
  | 'signing'
  | 'confirming'
  | 'success'
  | 'failed';

export type MarinadeDepositState = {
  phase: MarinadeDepositPhase;
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
      console.warn('[cardo marinade-deposit] receipt poll error', e);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`receipt poll timed out for ${hash}`);
}

export function useMarinadeDeposit() {
  const [state, setState] = useState<MarinadeDepositState>({ phase: 'idle' });
  const { writeContractAsync } = useRomeWrite();

  const deposit = useCallback(
    async (opts: {
      userEvmAddress: Address;
      msolMint: Hex;
      msolLeg: Hex;
      lamports: bigint;
    }) => {
      setState({ phase: 'idle' });
      try {
        const built = buildMarinadeDepositInvoke(opts);
        setState({ phase: 'signing' });
        const hash = await writeContractAsync({
          address: CPI_PRECOMPILE,
          abi: CPI_INVOKE_ABI,
          functionName: 'invoke',
          args: [built.program, built.accounts, built.data],
        });
        setState({ phase: 'confirming', hash });
        const r = await waitForReceipt(hash);
        if (r.status === 'reverted') {
          setState({
            phase: 'failed',
            hash,
            error:
              'Marinade deposit reverted. Common causes: PDA SOL balance < amount, mSOL ATA missing, deposit floor (state.min_deposit) tripped, or program is paused.',
          });
          return;
        }
        setState({ phase: 'success', hash });
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        setState((prev) => ({ ...prev, phase: 'failed', error: msg }));
      }
    },
    [writeContractAsync],
  );

  const reset = useCallback(() => setState({ phase: 'idle' }), []);
  return { state, deposit, reset } as const;
}
