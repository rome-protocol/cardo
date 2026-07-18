// useStreamflowCreate — submit a Streamflow create_v2 (vesting/payroll
// stream) via Rome's CPI precompile. Single ix, 18 accounts.
//
// Mirrors `lib/use-stake-pool-deposit.ts`: wagmi `writeContractAsync`
// → manual /api/rpc/rome receipt poll (per playbook §4.10).
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md
// (Family 8, Phase A — Sprint 1 continued).

import { useCallback, useState } from 'react';
import { useRomeWrite } from './use-rome-write';
import type { Address, Hex } from 'viem';
import { CPI_PRECOMPILE, CPI_INVOKE_ABI } from './cpi-precompile';
import {
  buildCreateStreamInvoke,
  type CreateStreamArgs,
} from './streamflow-instructions';

export type StreamCreatePhase =
  | 'idle'
  | 'signing'
  | 'confirming'
  | 'success'
  | 'failed';

export type StreamCreateState = {
  phase: StreamCreatePhase;
  /// Stream name (echoed for in-progress UI).
  name?: string;
  /// Total deposit (mint smallest unit).
  netAmount?: bigint;
  hash?: `0x${string}`;
  /// Resolved metadata PDA (the stream's identity on Solana).
  metadata?: Hex;
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
      console.warn('[cardo streamflow-create] receipt poll error', e);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`receipt poll timed out for ${hash}`);
}

export function useStreamflowCreate() {
  const [state, setState] = useState<StreamCreateState>({ phase: 'idle' });
  const { writeContractAsync } = useRomeWrite();

  const create = useCallback(
    async (opts: {
      userEvmAddress: Address;
      recipientHex: Hex;
      mintHex: Hex;
      tokenProgramHex?: Hex;
      stream: CreateStreamArgs;
    }) => {
      const name = opts.stream.streamName;
      const netAmount = opts.stream.netAmountDeposited;
      setState({ phase: 'idle', name, netAmount });
      try {
        const { program, accounts, data, addresses } = buildCreateStreamInvoke(opts);
        setState({
          phase: 'signing',
          name,
          netAmount,
          metadata: addresses.metadata,
        });
        const hash = await writeContractAsync({
          address: CPI_PRECOMPILE,
          abi: CPI_INVOKE_ABI,
          functionName: 'invoke',
          args: [program, accounts, data],
        });
        setState({
          phase: 'confirming',
          name,
          netAmount,
          hash,
          metadata: addresses.metadata,
        });
        const r = await waitForReceipt(hash);
        if (r.status === 'reverted') {
          setState({
            phase: 'failed',
            name,
            netAmount,
            hash,
            metadata: addresses.metadata,
            error: 'Streamflow create_v2 reverted on-chain',
          });
          return;
        }
        setState({
          phase: 'success',
          name,
          netAmount,
          hash,
          metadata: addresses.metadata,
        });
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        setState((prev) => ({ ...prev, phase: 'failed', error: msg }));
      }
    },
    [writeContractAsync],
  );

  const reset = useCallback(() => setState({ phase: 'idle' }), []);

  return { state, create, reset };
}
