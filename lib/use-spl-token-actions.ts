// useSplTokenActions — bundled hooks for SPL Token classic extensions
// on Cardo `/send`. One submit hook per ix, each mirroring the existing
// `useSplTransfer` pattern (wagmi writeContractAsync → manual Rome
// receipt poll).

import { useCallback, useState } from 'react';
import { useRomeWrite } from './use-rome-write';
import type { Hex } from 'viem';
import { CPI_INVOKE_ABI, CPI_PRECOMPILE } from './cpi-precompile';
import {
  buildSplApproveCheckedInvoke,
  buildSplBurnCheckedInvoke,
  buildSplCloseAccountInvoke,
  buildSplRevokeInvoke,
  buildSplSetAuthorityInvoke,
  buildSplSyncNativeInvoke,
  type SplTokenInvoke,
} from './spl-token-extensions';

export type SplActionPhase =
  | 'idle'
  | 'signing'
  | 'confirming'
  | 'success'
  | 'failed';

export type SplActionState = {
  phase: SplActionPhase;
  action?: 'approve' | 'revoke' | 'burn' | 'close' | 'sync-native' | 'set-authority';
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
      console.warn('[cardo spl-token-actions] receipt poll error', e);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`receipt poll timed out for ${hash}`);
}

function makeActionHook<TOpts>(
  action: NonNullable<SplActionState['action']>,
  build: (opts: TOpts) => SplTokenInvoke,
) {
  return function useAction() {
    const [state, setState] = useState<SplActionState>({ phase: 'idle' });
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
            setState({
              phase: 'failed',
              action,
              hash,
              error: `${action} reverted on-chain`,
            });
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

export const useSplApprove = makeActionHook('approve', buildSplApproveCheckedInvoke);
export const useSplRevoke = makeActionHook('revoke', buildSplRevokeInvoke);
export const useSplBurn = makeActionHook('burn', buildSplBurnCheckedInvoke);
export const useSplCloseAccount = makeActionHook('close', buildSplCloseAccountInvoke);
export const useSplSyncNative = makeActionHook('sync-native', buildSplSyncNativeInvoke);
export const useSplSetAuthority = makeActionHook('set-authority', buildSplSetAuthorityInvoke);

export type ApproveOpts = Parameters<typeof buildSplApproveCheckedInvoke>[0];
export type RevokeOpts = Parameters<typeof buildSplRevokeInvoke>[0];
export type BurnOpts = Parameters<typeof buildSplBurnCheckedInvoke>[0];
export type CloseAccountOpts = Parameters<typeof buildSplCloseAccountInvoke>[0];
export type SyncNativeOpts = Parameters<typeof buildSplSyncNativeInvoke>[0];
export type SetAuthorityOpts = Parameters<typeof buildSplSetAuthorityInvoke>[0];
