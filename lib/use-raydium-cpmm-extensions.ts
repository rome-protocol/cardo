// useRaydiumCpmmSwapBaseOutput / useRaydiumCpmmDeposit /
// useRaydiumCpmmWithdraw — extension hooks for /swap-raydium beyond
// the proven swap_base_input. Same submit pattern as
// use-raydium-cpmm-swap.

import { useCallback, useState } from 'react';
import { useRomeWrite } from './use-rome-write';
import type { Address, Hex } from 'viem';
import { CPI_INVOKE_ABI, CPI_PRECOMPILE } from './cpi-precompile';
import {
  buildRaydiumCpmmDepositInvoke,
  buildRaydiumCpmmSwapBaseOutputInvoke,
  buildRaydiumCpmmWithdrawInvoke,
} from './raydium-cpmm-instructions';
import type { RaydiumCpmmPoolEntry } from './raydium-cpmm-pools';

export type CpmmExtPhase =
  | 'idle'
  | 'signing'
  | 'confirming'
  | 'success'
  | 'failed';

export type CpmmExtState = {
  phase: CpmmExtPhase;
  side?: 'swap-base-output' | 'deposit' | 'withdraw';
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
      console.warn('[cardo cpmm-ext] receipt poll error', e);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`receipt poll timed out for ${hash}`);
}

export function useRaydiumCpmmSwapBaseOutput() {
  const [state, setState] = useState<CpmmExtState>({ phase: 'idle' });
  const { writeContractAsync } = useRomeWrite();

  const swap = useCallback(
    async (opts: {
      userEvmAddress: Address;
      pool: RaydiumCpmmPoolEntry;
      inputIsToken0: boolean;
      maxAmountIn: bigint;
      amountOut: bigint;
    }) => {
      setState({ phase: 'idle', side: 'swap-base-output' });
      try {
        const built = buildRaydiumCpmmSwapBaseOutputInvoke(opts);
        setState({ phase: 'signing', side: 'swap-base-output' });
        const hash = await writeContractAsync({
          address: CPI_PRECOMPILE,
          abi: CPI_INVOKE_ABI,
          functionName: 'invoke',
          args: [built.program, built.accounts, built.data],
        });
        setState({ phase: 'confirming', side: 'swap-base-output', hash });
        const r = await waitForReceipt(hash);
        if (r.status === 'reverted') {
          setState({
            phase: 'failed',
            side: 'swap-base-output',
            hash,
            error: 'swap_base_output reverted. Realized input exceeded max_amount_in (slippage).',
          });
          return;
        }
        setState({ phase: 'success', side: 'swap-base-output', hash });
      } catch (e) {
        setState((p) => ({ ...p, phase: 'failed', error: (e as Error).message ?? String(e) }));
      }
    },
    [writeContractAsync],
  );
  const reset = useCallback(() => setState({ phase: 'idle' }), []);
  return { state, swap, reset };
}

export function useRaydiumCpmmDeposit() {
  const [state, setState] = useState<CpmmExtState>({ phase: 'idle' });
  const { writeContractAsync } = useRomeWrite();

  const deposit = useCallback(
    async (opts: {
      userEvmAddress: Address;
      pool: RaydiumCpmmPoolEntry;
      lpTokenAmount: bigint;
      maximumToken0Amount: bigint;
      maximumToken1Amount: bigint;
    }) => {
      setState({ phase: 'idle', side: 'deposit' });
      try {
        const built = buildRaydiumCpmmDepositInvoke(opts);
        setState({ phase: 'signing', side: 'deposit' });
        const hash = await writeContractAsync({
          address: CPI_PRECOMPILE,
          abi: CPI_INVOKE_ABI,
          functionName: 'invoke',
          args: [built.program, built.accounts, built.data],
        });
        setState({ phase: 'confirming', side: 'deposit', hash });
        const r = await waitForReceipt(hash);
        if (r.status === 'reverted') {
          setState({
            phase: 'failed',
            side: 'deposit',
            hash,
            error: 'CPMM deposit reverted. Common causes: ATAs missing, slippage, or insufficient balance.',
          });
          return;
        }
        setState({ phase: 'success', side: 'deposit', hash });
      } catch (e) {
        setState((p) => ({ ...p, phase: 'failed', error: (e as Error).message ?? String(e) }));
      }
    },
    [writeContractAsync],
  );
  const reset = useCallback(() => setState({ phase: 'idle' }), []);
  return { state, deposit, reset };
}

export function useRaydiumCpmmWithdraw() {
  const [state, setState] = useState<CpmmExtState>({ phase: 'idle' });
  const { writeContractAsync } = useRomeWrite();

  const withdraw = useCallback(
    async (opts: {
      userEvmAddress: Address;
      pool: RaydiumCpmmPoolEntry;
      lpTokenAmount: bigint;
      minimumToken0Amount: bigint;
      minimumToken1Amount: bigint;
    }) => {
      setState({ phase: 'idle', side: 'withdraw' });
      try {
        const built = buildRaydiumCpmmWithdrawInvoke(opts);
        setState({ phase: 'signing', side: 'withdraw' });
        const hash = await writeContractAsync({
          address: CPI_PRECOMPILE,
          abi: CPI_INVOKE_ABI,
          functionName: 'invoke',
          args: [built.program, built.accounts, built.data],
        });
        setState({ phase: 'confirming', side: 'withdraw', hash });
        const r = await waitForReceipt(hash);
        if (r.status === 'reverted') {
          setState({
            phase: 'failed',
            side: 'withdraw',
            hash,
            error: 'CPMM withdraw reverted. Common causes: realized 0/1 below thresholds, or LP balance too low.',
          });
          return;
        }
        setState({ phase: 'success', side: 'withdraw', hash });
      } catch (e) {
        setState((p) => ({ ...p, phase: 'failed', error: (e as Error).message ?? String(e) }));
      }
    },
    [writeContractAsync],
  );
  const reset = useCallback(() => setState({ phase: 'idle' }), []);
  return { state, withdraw, reset };
}
