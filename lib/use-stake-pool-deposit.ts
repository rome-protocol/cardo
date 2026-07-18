// useStakePoolDeposit — submit an SPL stake-pool DepositSol via Rome's
// CPI precompile. One ix, atomic, no init / no refresh.
//
// Pattern mirrors `lib/use-vault-init.ts`: wagmi `writeContractAsync`
// → manual /api/rpc/rome receipt poll (Rome's
// `useWaitForTransactionReceipt` is flaky, per playbook §4.10).
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md
// (Family 1, Phase A — Sprint 1).

import { useCallback, useState } from 'react';
import { useRomeWrite } from './use-rome-write';
import type { Address } from 'viem';
import { CPI_PRECOMPILE, CPI_INVOKE_ABI } from './cpi-precompile';
import { buildDepositSolInvoke } from './stake-pool-instructions';
import type { StakePoolRegistryEntry } from './stake-pool-registry';

export type StakePoolDepositPhase =
  | 'idle'
  | 'signing'
  | 'confirming'
  | 'success'
  | 'failed';

export type StakePoolDepositState = {
  phase: StakePoolDepositPhase;
  /// Symbol being deposited into (e.g. "JitoSOL").
  symbol?: string;
  /// Lamports being deposited.
  lamports?: bigint;
  hash?: `0x${string}`;
  /// User's pool-token ATA (where pool tokens land on Solana).
  userPoolAta?: string;
  error?: string;
};

const POLL_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 2_000;

async function waitForReceipt(
  hash: `0x${string}`,
): Promise<{ status: 'success' | 'reverted'; transactionHash: `0x${string}` }> {
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
          transactionHash: json.result.transactionHash,
        };
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[cardo stake-pool-deposit] receipt poll error', e);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`receipt poll timed out for ${hash}`);
}

export function useStakePoolDeposit() {
  const [state, setState] = useState<StakePoolDepositState>({ phase: 'idle' });
  const { writeContractAsync } = useRomeWrite();

  const deposit = useCallback(
    async (opts: {
      userEvmAddress: Address;
      entry: StakePoolRegistryEntry;
      lamports: bigint;
    }) => {
      const symbol = opts.entry.symbol;
      setState({ phase: 'idle', symbol, lamports: opts.lamports });
      try {
        const { program, accounts, data, addresses } = buildDepositSolInvoke({
          userEvmAddress: opts.userEvmAddress,
          pool: opts.entry.pool,
          lamports: opts.lamports,
        });

        setState({ phase: 'signing', symbol, lamports: opts.lamports });
        const hash = await writeContractAsync({
          address: CPI_PRECOMPILE,
          abi: CPI_INVOKE_ABI,
          functionName: 'invoke',
          args: [program, accounts, data],
        });
        setState({
          phase: 'confirming',
          symbol,
          lamports: opts.lamports,
          hash,
          userPoolAta: addresses.userPoolAta,
        });

        const r = await waitForReceipt(hash);
        if (r.status === 'reverted') {
          setState({
            phase: 'failed',
            symbol,
            lamports: opts.lamports,
            hash,
            userPoolAta: addresses.userPoolAta,
            error: `${symbol} deposit reverted on-chain`,
          });
          return;
        }
        setState({
          phase: 'success',
          symbol,
          lamports: opts.lamports,
          hash,
          userPoolAta: addresses.userPoolAta,
        });
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        setState((prev) => ({
          ...prev,
          phase: 'failed',
          error: msg,
        }));
      }
    },
    [writeContractAsync],
  );

  const reset = useCallback(() => setState({ phase: 'idle' }), []);

  return { state, deposit, reset };
}
