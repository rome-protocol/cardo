// useOrcaSwap — submit an Orca Whirlpool swap via Rome's CPI precompile.
// Single ix, 11 accounts, single signer (the user's Rome PDA).
//
// Pattern matches Sprint 1 hooks: wagmi `writeContractAsync` →
// manual /api/rpc/rome receipt poll.
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md
// (Family 3 — Orca Whirlpool swap).

import { useCallback, useState } from 'react';
import { useRomeWrite } from './use-rome-write';
import type { Address } from 'viem';
import { CPI_PRECOMPILE, CPI_INVOKE_ABI } from './cpi-precompile';
import { buildOrcaSwapInvoke } from './orca-instructions';
import type { OrcaPool } from './orca-pools';

export type OrcaSwapPhase =
  | 'idle'
  | 'signing'
  | 'confirming'
  | 'success'
  | 'failed';

export type OrcaSwapState = {
  phase: OrcaSwapPhase;
  /// Direction label (e.g. "WSOL → USDC").
  label?: string;
  /// Amount input in smallest unit.
  amount?: bigint;
  hash?: `0x${string}`;
  error?: string;
};

const POLL_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 2_000;

async function waitForReceipt(
  hash: `0x${string}`,
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
        return { status: json.result.status === '0x1' ? 'success' : 'reverted' };
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[cardo orca-swap] receipt poll error', e);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`receipt poll timed out for ${hash}`);
}

export function useOrcaSwap() {
  const [state, setState] = useState<OrcaSwapState>({ phase: 'idle' });
  const { writeContractAsync } = useRomeWrite();

  const swap = useCallback(
    async (opts: {
      userEvmAddress: Address;
      pool: OrcaPool;
      currentTick: number;
      aToB: boolean;
      amount: bigint;
      otherAmountThreshold: bigint;
      label: string;
    }) => {
      setState({ phase: 'idle', label: opts.label, amount: opts.amount });
      try {
        const { program, accounts, data } = buildOrcaSwapInvoke({
          userEvmAddress: opts.userEvmAddress,
          pool: opts.pool,
          currentTick: opts.currentTick,
          aToB: opts.aToB,
          amount: opts.amount,
          otherAmountThreshold: opts.otherAmountThreshold,
        });
        setState({ phase: 'signing', label: opts.label, amount: opts.amount });
        const hash = await writeContractAsync({
          address: CPI_PRECOMPILE,
          abi: CPI_INVOKE_ABI,
          functionName: 'invoke',
          args: [program, accounts, data],
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
              "Orca swap reverted. Common causes: insufficient input balance, slippage exceeded, or current tick crossed multiple tick arrays mid-swap (try a smaller amount).",
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
