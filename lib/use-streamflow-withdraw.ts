// useStreamflowWithdraw — recipient claims vested tokens from a
// Streamflow stream via Rome's CPI precompile.
//
// Pattern mirrors `use-streamflow-create.ts`.

import { useCallback, useState } from 'react';
import { useRomeWrite } from './use-rome-write';
import type { Address, Hex } from 'viem';
import { CPI_INVOKE_ABI, CPI_PRECOMPILE } from './cpi-precompile';
import { buildStreamflowWithdrawInvoke } from './streamflow-instructions';

export type StreamflowWithdrawPhase =
  | 'idle'
  | 'signing'
  | 'confirming'
  | 'success'
  | 'failed';

export type StreamflowWithdrawState = {
  phase: StreamflowWithdrawPhase;
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
        return {
          status: json.result.status === '0x1' ? 'success' : 'reverted',
        };
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[cardo streamflow-withdraw] receipt poll error', e);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`receipt poll timed out for ${hash}`);
}

export function useStreamflowWithdraw() {
  const [state, setState] = useState<StreamflowWithdrawState>({ phase: 'idle' });
  const { writeContractAsync } = useRomeWrite();

  const withdraw = useCallback(
    async (opts: {
      userEvmAddress: Address;
      metadataHex: Hex;
      mintHex: Hex;
      recipientHex: Hex;
      tokenProgramHex?: Hex;
      partnerHex?: Hex;
      /// Withdraw amount in mint smallest unit. Pass `u64::MAX` (e.g.
      /// `2n ** 64n - 1n`) to claim everything currently vested.
      amount: bigint;
    }) => {
      setState({ phase: 'idle', amount: opts.amount });
      try {
        const built = buildStreamflowWithdrawInvoke({
          userEvmAddress: opts.userEvmAddress,
          metadataHex: opts.metadataHex,
          mintHex: opts.mintHex,
          recipientHex: opts.recipientHex,
          tokenProgramHex: opts.tokenProgramHex,
          partnerHex: opts.partnerHex,
          amount: opts.amount,
        });
        setState((s) => ({ ...s, phase: 'signing' }));
        const hash = await writeContractAsync({
          address: CPI_PRECOMPILE,
          abi: CPI_INVOKE_ABI,
          functionName: 'invoke',
          args: [built.program, built.accounts, built.data],
        });
        setState((s) => ({ ...s, phase: 'confirming', hash }));
        const r = await waitForReceipt(hash);
        if (r.status === 'reverted') {
          setState((s) => ({
            ...s,
            phase: 'failed',
            error:
              'Streamflow withdraw reverted. Common causes: not enough vested yet (cliff/period), authority is not the recipient, or amount exceeds available.',
          }));
          return;
        }
        setState((s) => ({ ...s, phase: 'success' }));
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        setState((s) => ({ ...s, phase: 'failed', error: msg }));
      }
    },
    [writeContractAsync],
  );

  const reset = useCallback(() => setState({ phase: 'idle' }), []);
  return { state, withdraw, reset } as const;
}
