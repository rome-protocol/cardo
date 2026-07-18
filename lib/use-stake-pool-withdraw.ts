// useStakePoolWithdrawSol — submit an SPL stake-pool WithdrawSol via
// Rome's CPI precompile. Burns the user's pool tokens (LST), credits
// SOL back to the user's PDA lamports.
//
// Pattern mirrors `use-stake-pool-deposit.ts`.

import { useCallback, useState } from 'react';
import { useRomeWrite } from './use-rome-write';
import type { Address, Hex } from 'viem';
import { CPI_INVOKE_ABI, CPI_PRECOMPILE } from './cpi-precompile';
import { buildWithdrawSolInvoke } from './stake-pool-instructions';
import type { StakePoolRegistryEntry } from './stake-pool-registry';

export type StakePoolWithdrawPhase =
  | 'idle'
  | 'signing'
  | 'confirming'
  | 'success'
  | 'failed';

export type StakePoolWithdrawState = {
  phase: StakePoolWithdrawPhase;
  symbol?: string;
  poolTokensIn?: bigint;
  hash?: Hex;
  userPoolAta?: string;
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
      console.warn('[cardo stake-pool-withdraw] receipt poll error', e);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`receipt poll timed out for ${hash}`);
}

export function useStakePoolWithdrawSol() {
  const [state, setState] = useState<StakePoolWithdrawState>({ phase: 'idle' });
  const { writeContractAsync } = useRomeWrite();

  const withdraw = useCallback(
    async (opts: {
      userEvmAddress: Address;
      pool: StakePoolRegistryEntry;
      poolTokensIn: bigint;
    }) => {
      setState({
        phase: 'idle',
        symbol: opts.pool.symbol,
        poolTokensIn: opts.poolTokensIn,
      });
      try {
        const built = buildWithdrawSolInvoke({
          userEvmAddress: opts.userEvmAddress,
          pool: opts.pool.pool,
          poolTokensIn: opts.poolTokensIn,
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
              'WithdrawSol reverted. Common causes: insufficient pool-token balance, pool with sol_withdraw_authority gate set, or stake-pool epoch update needed.',
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
