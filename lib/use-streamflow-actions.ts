// useStreamflowCancel + useStreamflowTopup — submit hooks for the
// Streamflow extension ix on Cardo `/pay`. Same pattern as
// use-streamflow-create + use-streamflow-withdraw.

import { useCallback, useState } from 'react';
import { useRomeWrite } from './use-rome-write';
import type { Address, Hex } from 'viem';
import { CPI_INVOKE_ABI, CPI_PRECOMPILE } from './cpi-precompile';
import {
  buildStreamflowCancelInvoke,
  buildStreamflowTopupInvoke,
  buildStreamflowTransferRecipientInvoke,
  buildStreamflowUpdateInvoke,
} from './streamflow-instructions';

export type StreamActionPhase =
  | 'idle'
  | 'signing'
  | 'confirming'
  | 'success'
  | 'failed';

export type StreamActionState = {
  phase: StreamActionPhase;
  action?: 'cancel' | 'topup' | 'update' | 'transfer-recipient';
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
      console.warn('[cardo streamflow-actions] receipt poll error', e);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`receipt poll timed out for ${hash}`);
}

export function useStreamflowCancel() {
  const [state, setState] = useState<StreamActionState>({ phase: 'idle' });
  const { writeContractAsync } = useRomeWrite();

  const cancel = useCallback(
    async (opts: {
      userEvmAddress: Address;
      metadataHex: Hex;
      mintHex: Hex;
      senderHex: Hex;
      recipientHex: Hex;
    }) => {
      setState({ phase: 'idle', action: 'cancel' });
      try {
        const built = buildStreamflowCancelInvoke(opts);
        setState({ phase: 'signing', action: 'cancel' });
        const hash = await writeContractAsync({
          address: CPI_PRECOMPILE,
          abi: CPI_INVOKE_ABI,
          functionName: 'invoke',
          args: [built.program, built.accounts, built.data],
        });
        setState({ phase: 'confirming', action: 'cancel', hash });
        const r = await waitForReceipt(hash);
        if (r.status === 'reverted') {
          setState({
            phase: 'failed',
            action: 'cancel',
            hash,
            error:
              'Cancel reverted. Common causes: caller is neither sender nor recipient with cancelable_by_X=true, stream already cancelled, or sender pubkey provided does not match the on-chain metadata.',
          });
          return;
        }
        setState({ phase: 'success', action: 'cancel', hash });
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        setState((prev) => ({ ...prev, phase: 'failed', error: msg }));
      }
    },
    [writeContractAsync],
  );

  const reset = useCallback(() => setState({ phase: 'idle' }), []);
  return { state, cancel, reset };
}

function makeWriteHook<TOpts>(
  action: NonNullable<StreamActionState['action']>,
  build: (opts: TOpts) => { program: Hex; accounts: ReturnType<typeof buildStreamflowCancelInvoke>['accounts']; data: Hex },
  errorHint: string,
) {
  return function useAction() {
    const [state, setState] = useState<StreamActionState>({ phase: 'idle' });
    const { writeContractAsync } = useRomeWrite();

    const submit = useCallback(
      async (opts: TOpts) => {
        setState({ phase: 'idle', action });
        try {
          const built = build(opts);
          setState({ phase: 'signing', action });
          const hash = await writeContractAsync({
            address: CPI_PRECOMPILE,
            abi: CPI_INVOKE_ABI,
            functionName: 'invoke',
            args: [built.program, built.accounts, built.data],
          });
          setState({ phase: 'confirming', action, hash });
          const r = await waitForReceipt(hash);
          if (r.status === 'reverted') {
            setState({ phase: 'failed', action, hash, error: errorHint });
            return;
          }
          setState({ phase: 'success', action, hash });
        } catch (e) {
          const msg = (e as Error).message ?? String(e);
          setState((prev) => ({ ...prev, phase: 'failed', error: msg }));
        }
      },
      [writeContractAsync],
    );
    const reset = useCallback(() => setState({ phase: 'idle' }), []);
    return { state, submit, reset };
  };
}

export const useStreamflowUpdate = makeWriteHook(
  'update',
  buildStreamflowUpdateInvoke,
  'Stream update reverted. Common causes: stream is paused/cancelled, or you are not the authority.',
);

export const useStreamflowTransferRecipient = makeWriteHook(
  'transfer-recipient',
  buildStreamflowTransferRecipientInvoke,
  'Transfer-recipient reverted. Common causes: caller is not the current recipient, or stream is closed.',
);

export function useStreamflowTopup() {
  const [state, setState] = useState<StreamActionState>({ phase: 'idle' });
  const { writeContractAsync } = useRomeWrite();

  const topup = useCallback(
    async (opts: {
      userEvmAddress: Address;
      metadataHex: Hex;
      mintHex: Hex;
      amount: bigint;
    }) => {
      setState({ phase: 'idle', action: 'topup' });
      try {
        const built = buildStreamflowTopupInvoke(opts);
        setState({ phase: 'signing', action: 'topup' });
        const hash = await writeContractAsync({
          address: CPI_PRECOMPILE,
          abi: CPI_INVOKE_ABI,
          functionName: 'invoke',
          args: [built.program, built.accounts, built.data],
        });
        setState({ phase: 'confirming', action: 'topup', hash });
        const r = await waitForReceipt(hash);
        if (r.status === 'reverted') {
          setState({
            phase: 'failed',
            action: 'topup',
            hash,
            error:
              'Topup reverted. Common causes: stream was created with can_topup=false, insufficient ATA balance, or stream already ended.',
          });
          return;
        }
        setState({ phase: 'success', action: 'topup', hash });
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        setState((prev) => ({ ...prev, phase: 'failed', error: msg }));
      }
    },
    [writeContractAsync],
  );

  const reset = useCallback(() => setState({ phase: 'idle' }), []);
  return { state, topup, reset };
}
