// useMangoCreate / useMangoDeposit / useMangoWithdraw — wagmi hooks
// driving Mango v4's accountCreate, tokenDeposit, tokenWithdraw via
// Rome's CPI precompile.
//
// Each hook is a tiny state machine (idle → signing → confirming →
// success/failed) with a manual receipt poll, same shape as the
// existing adapter hooks (use-orca-swap, use-pumpswap-swap, etc.).
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md

import { useCallback, useState } from 'react';
import { useRomeWrite } from './use-rome-write';
import type { Address, Hex } from 'viem';
import { CPI_INVOKE_ABI, CPI_PRECOMPILE } from './cpi-precompile';
import {
  buildMangoAccountCloseInvoke,
  buildMangoAccountCreateInvoke,
  buildMangoAccountEditInvoke,
  buildMangoAccountExpandInvoke,
  buildMangoTcsCancelInvoke,
  buildMangoTcsCreateInvoke,
  buildMangoTokenDepositInvoke,
  buildMangoTokenWithdrawInvoke,
} from './mango-instructions';

export type MangoPhase =
  | 'idle'
  | 'signing'
  | 'confirming'
  | 'success'
  | 'failed';

export type MangoState = {
  phase: MangoPhase;
  /// Identifies which side of the Mango lifecycle the hook is in.
  side?:
    | 'create'
    | 'deposit'
    | 'withdraw'
    | 'close'
    | 'edit'
    | 'expand'
    | 'tcs-create'
    | 'tcs-cancel';
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
      console.warn('[cardo mango] receipt poll error', e);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`receipt poll timed out for ${hash}`);
}

function makeMangoHook<TArgs>(
  side:
    | 'create'
    | 'deposit'
    | 'withdraw'
    | 'close'
    | 'edit'
    | 'expand'
    | 'tcs-create'
    | 'tcs-cancel',
  build: (args: TArgs) => {
    program: Hex;
    accounts: { pubkey: Hex; is_signer: boolean; is_writable: boolean }[];
    data: Hex;
  },
) {
  return function useHook() {
    const [state, setState] = useState<MangoState>({ phase: 'idle' });
    const { writeContractAsync } = useRomeWrite();

    const run = useCallback(
      async (args: TArgs) => {
        setState({ phase: 'idle', side });
        try {
          const built = build(args);
          setState({ phase: 'signing', side });
          const hash = await writeContractAsync({
            address: CPI_PRECOMPILE,
            abi: CPI_INVOKE_ABI,
            functionName: 'invoke',
            args: [built.program, built.accounts, built.data],
          });
          setState({ phase: 'confirming', side, hash });
          const r = await waitForReceipt(hash);
          if (r.status === 'reverted') {
            setState({
              phase: 'failed',
              side,
              hash,
              error:
                'Mango ' +
                side +
                ' reverted. Common causes: stale oracle, insufficient balance for the deposit, MangoAccount not created yet (run accountCreate first), or borrow disabled by allowBorrow=false on withdraw.',
            });
            return;
          }
          setState({ phase: 'success', side, hash });
        } catch (e) {
          setState((prev) => ({
            ...prev,
            phase: 'failed',
            error: (e as Error).message ?? String(e),
          }));
        }
      },
      [writeContractAsync],
    );

    const reset = useCallback(() => setState({ phase: 'idle' }), []);
    return { state, run, reset } as const;
  };
}

// Concrete hooks — each takes the same shape of args as its underlying
// builder, plus the phase machine.

type CreateArgs = Parameters<typeof buildMangoAccountCreateInvoke>[0];
type DepositArgs = Parameters<typeof buildMangoTokenDepositInvoke>[0];
type WithdrawArgs = Parameters<typeof buildMangoTokenWithdrawInvoke>[0];
type CloseArgs = Parameters<typeof buildMangoAccountCloseInvoke>[0];
type EditArgs = Parameters<typeof buildMangoAccountEditInvoke>[0];
type ExpandArgs = Parameters<typeof buildMangoAccountExpandInvoke>[0];
type TcsCreateArgs = Parameters<typeof buildMangoTcsCreateInvoke>[0];
type TcsCancelArgs = Parameters<typeof buildMangoTcsCancelInvoke>[0];

const _useMangoCreateInner = makeMangoHook<CreateArgs>(
  'create',
  buildMangoAccountCreateInvoke,
);
const _useMangoDepositInner = makeMangoHook<DepositArgs>(
  'deposit',
  buildMangoTokenDepositInvoke,
);
const _useMangoWithdrawInner = makeMangoHook<WithdrawArgs>(
  'withdraw',
  buildMangoTokenWithdrawInvoke,
);
const _useMangoCloseInner = makeMangoHook<CloseArgs>(
  'close',
  buildMangoAccountCloseInvoke,
);
const _useMangoEditInner = makeMangoHook<EditArgs>(
  'edit',
  buildMangoAccountEditInvoke,
);
const _useMangoExpandInner = makeMangoHook<ExpandArgs>(
  'expand',
  buildMangoAccountExpandInvoke,
);
const _useMangoTcsCreateInner = makeMangoHook<TcsCreateArgs>(
  'tcs-create',
  buildMangoTcsCreateInvoke,
);
const _useMangoTcsCancelInner = makeMangoHook<TcsCancelArgs>(
  'tcs-cancel',
  buildMangoTcsCancelInvoke,
);

export function useMangoCreate() {
  const { state, run, reset } = _useMangoCreateInner();
  return { state, create: run, reset } as const;
}
export function useMangoDeposit() {
  const { state, run, reset } = _useMangoDepositInner();
  return { state, deposit: run, reset } as const;
}
export function useMangoWithdraw() {
  const { state, run, reset } = _useMangoWithdrawInner();
  return { state, withdraw: run, reset } as const;
}
export function useMangoClose() {
  const { state, run, reset } = _useMangoCloseInner();
  return { state, close: run, reset } as const;
}
export function useMangoEdit() {
  const { state, run, reset } = _useMangoEditInner();
  return { state, edit: run, reset } as const;
}
export function useMangoExpand() {
  const { state, run, reset } = _useMangoExpandInner();
  return { state, expand: run, reset } as const;
}
export function useMangoTcsCreate() {
  const { state, run, reset } = _useMangoTcsCreateInner();
  return { state, createTcs: run, reset } as const;
}
export function useMangoTcsCancel() {
  const { state, run, reset } = _useMangoTcsCancelInner();
  return { state, cancelTcs: run, reset } as const;
}

// Re-export `Address` shim so consumers don't have to import viem
// alongside this module. (Convenience only.)
export type { Address };
