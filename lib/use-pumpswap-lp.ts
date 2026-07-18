// usePumpSwapDeposit / usePumpSwapWithdraw — LP add/remove on PumpSwap
// pools via Rome's CPI precompile. Same submit pattern as
// usePumpswapSwap (wagmi writeContractAsync → manual /api/rpc/rome
// receipt poll).

import { useCallback, useState } from 'react';
import { useRomeWrite } from './use-rome-write';
import type { Address, Hex } from 'viem';
import { CPI_INVOKE_ABI, CPI_PRECOMPILE } from './cpi-precompile';
import {
  buildPumpSwapDepositInvoke,
  buildPumpSwapWithdrawInvoke,
} from './pumpswap-instructions';
import type { PumpSwapPool } from './pumpswap-pools';

export type PumpSwapLpPhase =
  | 'idle'
  | 'signing'
  | 'confirming'
  | 'success'
  | 'failed';

export type PumpSwapLpState = {
  phase: PumpSwapLpPhase;
  side?: 'deposit' | 'withdraw';
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
      console.warn('[cardo pumpswap-lp] receipt poll error', e);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`receipt poll timed out for ${hash}`);
}

export function usePumpSwapDeposit() {
  const [state, setState] = useState<PumpSwapLpState>({ phase: 'idle' });
  const { writeContractAsync } = useRomeWrite();

  const deposit = useCallback(
    async (opts: {
      userEvmAddress: Address;
      pool: PumpSwapPool;
      poolPubkey: string;
      lpTokenAmountOut: bigint;
      maxBaseAmountIn: bigint;
      maxQuoteAmountIn: bigint;
    }) => {
      setState({ phase: 'idle', side: 'deposit' });
      try {
        const built = buildPumpSwapDepositInvoke(opts);
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
            error:
              'PumpSwap deposit reverted. Common causes: pool reserves drifted past your max-in slippage guards, or LP-mint user ATA does not exist yet (pre-create via /send).',
          });
          return;
        }
        setState({ phase: 'success', side: 'deposit', hash });
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        setState((prev) => ({ ...prev, phase: 'failed', error: msg }));
      }
    },
    [writeContractAsync],
  );
  const reset = useCallback(() => setState({ phase: 'idle' }), []);
  return { state, deposit, reset };
}

export function usePumpSwapWithdraw() {
  const [state, setState] = useState<PumpSwapLpState>({ phase: 'idle' });
  const { writeContractAsync } = useRomeWrite();

  const withdraw = useCallback(
    async (opts: {
      userEvmAddress: Address;
      pool: PumpSwapPool;
      poolPubkey: string;
      lpTokenAmountIn: bigint;
      minBaseAmountOut: bigint;
      minQuoteAmountOut: bigint;
    }) => {
      setState({ phase: 'idle', side: 'withdraw' });
      try {
        const built = buildPumpSwapWithdrawInvoke(opts);
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
            error:
              'PumpSwap withdraw reverted. Common causes: realized base/quote out below your minimums (slippage guard), or insufficient LP balance.',
          });
          return;
        }
        setState({ phase: 'success', side: 'withdraw', hash });
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        setState((prev) => ({ ...prev, phase: 'failed', error: msg }));
      }
    },
    [writeContractAsync],
  );
  const reset = useCallback(() => setState({ phase: 'idle' }), []);
  return { state, withdraw, reset };
}
