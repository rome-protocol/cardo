// useDammV2AddLiquidity / useDammV2RemoveLiquidity — DAMM v2 LP
// add/remove via Rome's CPI precompile. Same pattern as useDammV2Swap.

import { useCallback, useState } from 'react';
import { useRomeWrite } from './use-rome-write';
import type { Address, Hex } from 'viem';
import { CPI_INVOKE_ABI, CPI_PRECOMPILE } from './cpi-precompile';
import {
  buildDammV2AddLiquidityInvoke,
  buildDammV2RemoveLiquidityInvoke,
} from './damm-v2-instructions';
import type { DammV2Pool } from './damm-v2-pools';

export type DammV2LpPhase =
  | 'idle'
  | 'signing'
  | 'confirming'
  | 'success'
  | 'failed';

export type DammV2LpState = {
  phase: DammV2LpPhase;
  side?: 'add' | 'remove';
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
      console.warn('[cardo damm-v2-lp] receipt poll error', e);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`receipt poll timed out for ${hash}`);
}

export function useDammV2AddLiquidity() {
  const [state, setState] = useState<DammV2LpState>({ phase: 'idle' });
  const { writeContractAsync } = useRomeWrite();

  const add = useCallback(
    async (opts: {
      userEvmAddress: Address;
      pool: DammV2Pool;
      positionNftMintHex: Hex;
      liquidityDelta: bigint;
      tokenAAmountThreshold: bigint;
      tokenBAmountThreshold: bigint;
    }) => {
      setState({ phase: 'idle', side: 'add' });
      try {
        const built = buildDammV2AddLiquidityInvoke(opts);
        setState({ phase: 'signing', side: 'add' });
        const hash = await writeContractAsync({
          address: CPI_PRECOMPILE,
          abi: CPI_INVOKE_ABI,
          functionName: 'invoke',
          args: [built.program, built.accounts, built.data],
        });
        setState({ phase: 'confirming', side: 'add', hash });
        const r = await waitForReceipt(hash);
        if (r.status === 'reverted') {
          setState({
            phase: 'failed',
            side: 'add',
            hash,
            error:
              'add_liquidity reverted. Common causes: position NFT not held by user, slippage threshold exceeded, or pool paused.',
          });
          return;
        }
        setState({ phase: 'success', side: 'add', hash });
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        setState((prev) => ({ ...prev, phase: 'failed', error: msg }));
      }
    },
    [writeContractAsync],
  );
  const reset = useCallback(() => setState({ phase: 'idle' }), []);
  return { state, add, reset };
}

export function useDammV2RemoveLiquidity() {
  const [state, setState] = useState<DammV2LpState>({ phase: 'idle' });
  const { writeContractAsync } = useRomeWrite();

  const remove = useCallback(
    async (opts: {
      userEvmAddress: Address;
      pool: DammV2Pool;
      positionNftMintHex: Hex;
      liquidityDelta: bigint | null;
      tokenAAmountThreshold: bigint;
      tokenBAmountThreshold: bigint;
    }) => {
      setState({ phase: 'idle', side: 'remove' });
      try {
        const built = buildDammV2RemoveLiquidityInvoke(opts);
        setState({ phase: 'signing', side: 'remove' });
        const hash = await writeContractAsync({
          address: CPI_PRECOMPILE,
          abi: CPI_INVOKE_ABI,
          functionName: 'invoke',
          args: [built.program, built.accounts, built.data],
        });
        setState({ phase: 'confirming', side: 'remove', hash });
        const r = await waitForReceipt(hash);
        if (r.status === 'reverted') {
          setState({
            phase: 'failed',
            side: 'remove',
            hash,
            error:
              'remove_liquidity reverted. Common causes: realized A/B below thresholds (slippage guard), liquidityDelta exceeds position size, or position not held.',
          });
          return;
        }
        setState({ phase: 'success', side: 'remove', hash });
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        setState((prev) => ({ ...prev, phase: 'failed', error: msg }));
      }
    },
    [writeContractAsync],
  );
  const reset = useCallback(() => setState({ phase: 'idle' }), []);
  return { state, remove, reset };
}
